import { text, type MItem, type MondayApi } from "../domain";
import {
  DeferredError,
  LeaseLostError,
  ManualOnlyError,
  ManualReviewError,
  MondayRejectedError,
  MondayTransientError,
  MondayUncertainError,
  ValidationError,
} from "../errors";
import type { Logger } from "../logger";
import { LABELS, PARENT_BOARD_ID, SUBITEM_BOARD_ID, SUB_COLS } from "../mapping/boards";
import { comparableOfItem, type ConvertOpts } from "../mapping/convert";
import type { SchemaGuard } from "../monday/schema";
import type { Store } from "../store/store";
import { CHANGE_ID_RE, parseChange, type ChangeRequest } from "../validation/change";
import { ParentStatusSync } from "./parentStatus";
import { buildPlan, intentOf, reconcile, type Intent, type Plan } from "./plan";

export interface ExecutorDeps {
  api: MondayApi;
  store: Store;
  schema: SchemaGuard;
  log: Logger;
  dryRun: boolean;
  convert: ConvertOpts;
}

export type Outcome =
  | { status: "ignored"; reason: string }
  | { status: "skipped"; reason: string; changeId: string }
  | { status: "applied" | "failed" | "manual_review" | "dry_run" | "lease_lost"; changeId: string; code?: string };

export class Executor {
  private readonly parents: ParentStatusSync;

  constructor(private readonly d: ExecutorDeps) {
    this.parents = new ParentStatusSync(d.api, d.store, d.log, d.dryRun);
  }

  /** For an applied create: the id of its record if that record no longer exists/active on the expected board. */
  private async missingCreatedRecord(changeId: string): Promise<string | null> {
    const row = this.d.store.get(changeId);
    if (!row || row.state !== "applied" || !row.result_item_id || !row.intent) return null;
    let intent: { kind?: string; boardId?: string };
    try {
      intent = JSON.parse(row.intent);
    } catch {
      return null;
    }
    if (intent.kind !== "create") return null; // updates / deletes / opt-outs are never re-applied
    const item = await this.d.api.getItem(row.result_item_id); // transient errors propagate → job retried
    const present = !!item && item.boardId === intent.boardId && item.state === "active";
    return present ? null : row.result_item_id;
  }

  /** A reviewer changed a decision (e.g. rejected): recalculate the parent of that subitem. */
  async refreshParentOfSubitem(subitemId: string): Promise<void> {
    const sub = await this.d.api.getItem(subitemId); // transient errors propagate → job retried
    if (!sub || sub.boardId !== SUBITEM_BOARD_ID || !sub.parentId) return;
    await this.refreshParent(sub.parentId);
  }

  /** Retry parent-status updates that failed earlier (called periodically by the worker). */
  sweepParents(): Promise<number> {
    return this.parents.sweep();
  }

  private async setSync(subitemId: string, label: string, extra: Record<string, unknown> = {}) {
    if (this.d.dryRun) return;
    try {
      await this.d.api.changeColumns(SUBITEM_BOARD_ID, subitemId, { [SUB_COLS.sync]: { label }, ...extra });
    } catch (e) {
      // Control-column writes are idempotent: an unknown outcome is simply retried, never a manual-review case.
      if (e instanceof MondayUncertainError) throw new MondayTransientError("status write outcome unknown");
      throw e;
    }
  }

  /** Best-effort status write; failure here must not mask the real outcome. */
  private async setSyncQuiet(subitemId: string, label: string) {
    try {
      await this.setSync(subitemId, label);
    } catch {
      this.d.log.warn("sync_status_write_failed", { subitemId });
    }
  }

  /** Never throws: a parent-status problem must not change or lose the subitem's execution result. */
  private async refreshParent(parentId: string | undefined) {
    try {
      await this.parents.refresh(parentId);
    } catch (e) {
      this.d.log.warn("parent_status_refresh_error", { parentId, err: e as Error });
    }
  }

  async process(subitemId: string, expectedParentId?: string | null): Promise<Outcome> {
    const { api, store, log } = this.d;
    const sub = await api.getItem(subitemId); // transient errors propagate → job retried
    if (!sub || sub.boardId !== SUBITEM_BOARD_ID) return { status: "ignored", reason: "wrong_board_or_missing" };
    if (text(sub, SUB_COLS.decision) !== LABELS.approved) return { status: "ignored", reason: "not_approved" };
    if (expectedParentId && sub.parentId !== expectedParentId) return { status: "ignored", reason: "parent_mismatch" };
    const changeId = text(sub, SUB_COLS.changeId);
    if (!CHANGE_ID_RE.test(changeId)) {
      log.warn("missing_or_invalid_change_id", { subitemId });
      return { status: "ignored", reason: "invalid_change_id" };
    }

    let claim = store.claim(changeId, subitemId, sub.parentId ?? null);
    if (!claim.acquired && claim.reason === "applied" && !this.d.dryRun) {
      // Safety net for created records: if the record this change created is gone, create it again.
      const missing = await this.missingCreatedRecord(changeId);
      if (missing && store.reopenAppliedCreate(changeId, missing)) {
        log.warn("created_record_missing_reapplying", { changeId });
        claim = store.claim(changeId, subitemId, sub.parentId ?? null);
      }
    }
    if (!claim.acquired) {
      log.info("change_skipped", { changeId, reason: claim.reason });
      return { status: "skipped", reason: claim.reason, changeId };
    }
    const { owner, row } = claim;
    log.info("change_claimed", { changeId, phase: row.phase, attempt: row.attempts });

    try {
      const out = await this.run(changeId, owner, subitemId, row.phase, row.intent, row.result_item_id);
      await this.refreshParent(sub.parentId);
      return out;
    } catch (e) {
      return await this.handleError(e, changeId, owner, subitemId, sub.parentId);
    }
  }

  private async handleError(
    e: unknown,
    changeId: string,
    owner: string,
    subitemId: string,
    parentId?: string,
  ): Promise<Outcome> {
    const { store, log } = this.d;
    if (e instanceof LeaseLostError) {
      log.warn("lease_lost", { changeId });
      return { status: "lease_lost", changeId };
    }
    if (e instanceof MondayTransientError || e instanceof DeferredError) {
      store.release(changeId, owner); // keep phase/intent; job will be retried
      throw e;
    }
    let state: "failed" | "manual_review" = "failed";
    let code = "INTERNAL_ERROR";
    let writeSync = true;
    if (e instanceof ValidationError) code = e.code;
    else if (e instanceof MondayRejectedError) code = "MONDAY_REJECTED_" + e.code;
    else if (e instanceof ManualReviewError) {
      state = "manual_review";
      code = e.code;
    } else if (e instanceof ManualOnlyError) {
      state = "manual_review";
      code = e.code;
      writeSync = false;
    } else {
      // Unknown error: if a mutation may be in flight we cannot know the outcome.
      const row = store.get(changeId);
      if (row && (row.phase === "mutating" || e instanceof MondayUncertainError)) {
        state = "manual_review";
        code = e instanceof MondayUncertainError ? "UNCERTAIN_OUTCOME" : "UNEXPECTED_DURING_MUTATION";
      }
      log.error("unexpected_error", { changeId, err: e as Error });
    }
    try {
      store.finish(changeId, owner, state, code);
    } catch (le) {
      if (le instanceof LeaseLostError) return { status: "lease_lost", changeId };
      throw le;
    }
    // Detail = column/board ids only (never values); helps diagnose SCHEMA_DRIFT etc.
    const detail = e instanceof Error && e.message !== code && !(e instanceof MondayRejectedError) ? e.message : undefined;
    log.warn("change_not_applied", { changeId, state, code, detail });
    if (writeSync) {
      await this.setSyncQuiet(subitemId, LABELS.syncFailed);
      await this.refreshParent(parentId);
    }
    return { status: state, changeId, code };
  }

  private async loadAndParse(subitemId: string): Promise<{ sub: MItem; req: ChangeRequest }> {
    const { api } = this.d;
    // Safety rule 1: re-fetch the subitem and confirm it is still approved.
    const sub = await api.getItem(subitemId);
    if (!sub || text(sub, SUB_COLS.decision) !== LABELS.approved) throw new ValidationError("NO_LONGER_APPROVED");
    if (!sub.parentId) throw new ValidationError("PARENT_MISSING");
    const parent = await api.getItem(sub.parentId);
    if (!parent || parent.boardId !== PARENT_BOARD_ID) throw new ValidationError("PARENT_NOT_FOUND");
    return { sub, req: parseChange(sub, parent) };
  }

  private async run(
    changeId: string,
    owner: string,
    subitemId: string,
    phase: string,
    intentJson: string | null,
    resultItemId: string | null,
    depth = 0,
  ): Promise<Outcome> {
    const { api, store, log } = this.d;

    if (phase === "mutated") return this.finalize(changeId, owner, subitemId, resultItemId);

    if (phase === "mutating") {
      // Crash (or ambiguous error) after the intent was recorded: reconcile before anything else.
      if (!intentJson) throw new ManualReviewError("INTENT_MISSING");
      const rec = await reconcile(api, JSON.parse(intentJson) as Intent);
      log.info("reconciled", { changeId, result: rec.status });
      if (rec.status === "applied") {
        store.setMutated(changeId, owner, rec.itemId ?? null);
        return this.finalize(changeId, owner, subitemId, rec.itemId ?? null);
      }
      if (depth >= 1) throw new ManualReviewError("RETRY_AFTER_RECONCILE_EXHAUSTED");
      store.clearIntent(changeId, owner);
      return this.run(changeId, owner, subitemId, "validating", null, null, depth + 1);
    }

    // validating
    await this.d.schema.assertControlLabels();
    await this.d.schema.assertTechnicalColumns();
    const { req } = await this.loadAndParse(subitemId);
    const parentOf = req.parentId;
    // Sequential execution per graduate+board: the last successfully executed approval determines the value.
    if (!store.acquireLock(`${req.board.id}:${req.nationalId}`, changeId)) {
      log.info("target_busy", { changeId });
      throw new DeferredError("TARGET_BUSY");
    }
    const plan = await buildPlan(req, this.d);
    store.renew(changeId, owner);

    if (this.d.dryRun) {
      log.info("dry_run_plan", {
        changeId,
        kind: plan.kind,
        board: req.board.key,
        columns: Object.keys(plan.kind === "archive" ? {} : plan.values).join(","),
        targets: plan.kind === "opt_out" ? plan.targets.length : undefined,
      });
      store.finish(changeId, owner, "dry_run", "DRY_RUN");
      return { status: "dry_run", changeId };
    }

    if (plan.kind === "opt_out") {
      log.info("opt_out_plan", { changeId, targets: plan.targets.length, skippedOwnership: plan.skippedOwnership });
      if (plan.targets.length === 0) {
        // Nothing to change on the source board: complete the approved change without any target write.
        store.setMutated(changeId, owner, null);
        return this.finalize(changeId, owner, subitemId, null);
      }
    }

    await this.setSync(subitemId, LABELS.syncRunning);
    await this.refreshParent(parentOf);
    // Last look before the irreversible step: still approved?
    await this.loadAndParse(subitemId);

    store.beginMutation(changeId, owner, intentOf(plan));
    let newId: string | null = null;
    try {
      newId = await this.execute(plan, changeId, owner);
    } catch (e) {
      if (e instanceof MondayRejectedError) {
        store.clearIntent(changeId, owner);
        throw e;
      }
      if (e instanceof MondayUncertainError || e instanceof MondayTransientError) {
        log.warn("mutation_outcome_uncertain", { changeId });
        const rec = await reconcile(api, intentOf(plan)); // ambiguity → ManualReviewError
        if (rec.status === "applied") {
          newId = rec.itemId ?? null;
        } else {
          store.clearIntent(changeId, owner);
          throw new ValidationError("MUTATION_FAILED_NOT_APPLIED");
        }
      } else {
        throw e;
      }
    }
    store.setMutated(changeId, owner, newId);
    return this.finalize(changeId, owner, subitemId, newId);
  }

  private async execute(plan: Plan, changeId: string, owner: string): Promise<string | null> {
    const { api, store } = this.d;
    if (plan.kind === "opt_out") {
      // One record at a time; each write is idempotent, so a crash/partial failure resumes safely.
      for (const id of plan.targets) {
        store.renew(changeId, owner);
        const item = await api.getItem(id); // re-verify right before touching it
        if (!item || item.boardId !== plan.boardId) throw new ManualReviewError("OPT_OUT_TARGET_UNREADABLE");
        if (item.state !== "active") continue;
        if ((item.columns[plan.ownerColumn]?.text ?? "").trim() !== plan.ownerValue)
          throw new ManualReviewError("OPT_OUT_OWNERSHIP_CHANGED");
        if (comparableOfItem("status", item.columns[plan.column]) === plan.label) continue;
        await api.changeColumns(plan.boardId, id, plan.values);
      }
      return null;
    }
    if (plan.kind === "update") {
      await api.changeColumns(plan.boardId, plan.itemId, plan.values);
      return null;
    }
    if (plan.kind === "create") return api.createItem(plan.boardId, plan.name, plan.values);
    await api.archiveItem(plan.itemId);
    return null;
  }

  private async finalize(
    changeId: string,
    owner: string,
    subitemId: string,
    resultItemId: string | null,
  ): Promise<Outcome> {
    const { store, log } = this.d;
    const extra = resultItemId ? { [SUB_COLS.targetRecordId]: resultItemId } : {};
    try {
      await this.setSync(subitemId, LABELS.syncDone, extra);
    } catch (e) {
      // Mutation is done and durably recorded; only the status write is pending. Retry later, never re-mutate.
      store.release(changeId, owner);
      log.warn("finalize_deferred", { changeId });
      throw new MondayTransientError("finalize status write failed");
    }
    store.finish(changeId, owner, "applied");
    log.info("change_applied", { changeId });
    return { status: "applied", changeId };
  }
}
