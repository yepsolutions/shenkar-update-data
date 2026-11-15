/** Builds a verified, side-effect-free plan for an approved change (safety rules 2-6). */
import type { ColumnDef, MItem, MondayApi } from "../domain";
import { ValidationError, ManualReviewError } from "../errors";
import { BOARDS, OPT_OUT_STATUS_LABEL, type BoardSpec } from "../mapping/boards";
import {
  ConversionError,
  comparableOfItem,
  convertProposed,
  hashComparable,
  type ConvertOpts,
} from "../mapping/convert";
import type { SchemaGuard } from "../monday/schema";
import type { ChangeRequest } from "../validation/change";

export type Plan =
  | {
      kind: "update";
      boardId: string;
      itemId: string;
      values: Record<string, unknown>;
      /** column → hash of comparable value, before and after (no plaintext at rest) */
      before: Record<string, string>;
      after: Record<string, string>;
      types: Record<string, string>;
    }
  | {
      kind: "create";
      boardId: string;
      name: string;
      values: Record<string, unknown>;
      ownerColumn: string;
      ownerValue: string;
      baselineIds: string[];
      after: Record<string, string>;
      types: Record<string, string>;
    }
  | { kind: "archive"; boardId: string; itemId: string }
  | {
      /** Community interest opt-out: set interest_status on the graduate's own records; never archive/delete. */
      kind: "opt_out";
      boardId: string;
      ownerColumn: string;
      ownerValue: string;
      column: string;
      label: string;
      values: Record<string, unknown>;
      /** Verified, owned, active records that still need the update (empty ⇒ no-op). */
      targets: string[];
      /** Records returned by the search whose owner is not an exact match: never modified. */
      skippedOwnership: number;
    };

/** The part of a plan persisted before mutating (hashes and ids only). */
export function intentOf(p: Plan) {
  if (p.kind === "update") return { kind: p.kind, boardId: p.boardId, itemId: p.itemId, before: p.before, after: p.after, types: p.types };
  if (p.kind === "create")
    return { kind: p.kind, boardId: p.boardId, ownerColumn: p.ownerColumn, ownerValue: p.ownerValue, baselineIds: p.baselineIds, after: p.after, types: p.types };
  if (p.kind === "opt_out")
    return { kind: p.kind, boardId: p.boardId, ownerColumn: p.ownerColumn, ownerValue: p.ownerValue, column: p.column, label: p.label, targets: p.targets };
  return { kind: p.kind, boardId: p.boardId, itemId: p.itemId };
}
export type Intent = ReturnType<typeof intentOf>;

export interface PlanDeps {
  api: MondayApi;
  schema: SchemaGuard;
  convert: ConvertOpts;
}

/** Applies the board's explicit, column-specific alias (exact match only; anything else passes through unchanged). */
export function aliasValue(spec: BoardSpec, column: string, raw: string): string {
  const map = spec.labelAliases?.[column];
  return map && Object.prototype.hasOwnProperty.call(map, raw) ? map[raw]! : raw;
}

/** Exactly one graduate on the Alumni board must carry this national ID (exact string match). */
export async function verifyGraduate(api: MondayApi, nationalId: string): Promise<MItem> {
  const alumni = BOARDS.alumni;
  const hits = (await api.findItemsByColumn(alumni.id, alumni.ownerColumn, nationalId)).filter(
    (i) => i.boardId === alumni.id && i.state === "active" && (i.columns[alumni.ownerColumn]?.text ?? "").trim() === nationalId,
  );
  if (hits.length === 0) throw new ValidationError("GRADUATE_NOT_FOUND");
  if (hits.length > 1) throw new ValidationError("GRADUATE_AMBIGUOUS");
  return hits[0]!;
}

/** Target must exist on the expected board, be active, and belong to the request's graduate. */
export async function verifyTarget(api: MondayApi, spec: BoardSpec, req: ChangeRequest, graduate: MItem): Promise<MItem> {
  const id = req.targetRecordId!;
  const item = await api.getItem(id);
  if (!item) throw new ValidationError("TARGET_NOT_FOUND");
  if (item.boardId !== spec.id) throw new ValidationError("TARGET_WRONG_BOARD");
  if (item.state !== "active") throw new ValidationError("TARGET_NOT_ACTIVE");
  if (spec.key === "alumni") {
    if (item.id !== graduate.id) throw new ValidationError("OWNERSHIP_MISMATCH");
  }
  const owner = (item.columns[spec.ownerColumn]?.text ?? "").trim();
  if (!owner) throw new ValidationError("OWNERSHIP_AMBIGUOUS");
  if (owner !== req.nationalId) throw new ValidationError("OWNERSHIP_MISMATCH");
  return item;
}

async function convertField(
  deps: PlanDeps,
  spec: BoardSpec,
  column: string,
  raw: string,
): Promise<{ def: ColumnDef; monday: unknown; comparable: string }> {
  const def = await deps.schema.writableColumn(spec, column);
  // Columns with an explicit alias map are yes/no labels: an empty value is never a valid new value.
  if (spec.labelAliases?.[column] && raw.trim() === "") throw new ValidationError("INVALID_VALUE_EMPTY");
  try {
    const c = convertProposed(def.type, aliasValue(spec, column, raw), def, deps.convert);
    return { def, monday: c.monday, comparable: c.comparable };
  } catch (e) {
    if (e instanceof ConversionError) throw new ValidationError("INVALID_VALUE_" + e.code);
    throw e;
  }
}

export async function buildPlan(req: ChangeRequest, deps: PlanDeps): Promise<Plan> {
  const spec = req.board;
  await deps.schema.assertOwnerColumn(spec);
  const graduate = await verifyGraduate(deps.api, req.nationalId);

  if (req.op === "create") {
    const keys = Object.keys(req.fields).filter((k) => k !== spec.ownerColumn);
    if (keys.length === 0) throw new ValidationError("EMPTY_PAYLOAD");
    if (req.fields[spec.ownerColumn] !== undefined && req.fields[spec.ownerColumn] !== req.nationalId)
      throw new ValidationError("OWNERSHIP_MISMATCH");
    const values: Record<string, unknown> = {};
    const after: Record<string, string> = {};
    const types: Record<string, string> = {};
    for (const k of keys) {
      const c = await convertField(deps, spec, k, req.fields[k]!);
      values[k] = c.monday;
      after[k] = hashComparable(k, c.comparable);
      types[k] = c.def.type;
    }
    if (spec.requireAnyOf?.length && !spec.requireAnyOf.some((k) => (req.fields[k] ?? "").trim() !== ""))
      throw new ValidationError("REQUIRED_FIELD_MISSING");
    values[spec.ownerColumn] = req.nationalId;
    const baseline = (await deps.api.findItemsByColumn(spec.id, spec.ownerColumn, req.nationalId))
      .filter((i) => i.boardId === spec.id)
      .map((i) => i.id);
    return {
      kind: "create",
      boardId: spec.id,
      name: spec.itemName(req.fields, req.alumniName),
      values,
      ownerColumn: spec.ownerColumn,
      ownerValue: req.nationalId,
      baselineIds: baseline,
      after,
      types,
    };
  }

  if (req.op === "special") return buildOptOutPlan(req, deps);

  const target = await verifyTarget(deps.api, spec, req, graduate);

  if (req.op === "delete") {
    // Extra protection: only an exact, verified, non-Alumni, active record on an archivable board.
    if (spec.key === "alumni" || !spec.canArchive) throw new ValidationError("ARCHIVE_NOT_ALLOWED");
    return { kind: "archive", boardId: spec.id, itemId: target.id };
  }

  // update (single or grouped). Last executed approval wins: the request's original values are historical
  // only and are NOT preconditions; target, ownership, field and new value are all verified above/below.
  const fields: Record<string, string> = req.kind === "single" ? { [req.field]: req.newValue } : req.fields;
  if (Object.keys(fields).length === 0) throw new ValidationError("EMPTY_PAYLOAD");
  if (Object.keys(fields).includes(spec.ownerColumn)) throw new ValidationError("COLUMN_NOT_WRITABLE");

  const values: Record<string, unknown> = {};
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  const types: Record<string, string> = {};
  for (const [k, raw] of Object.entries(fields)) {
    const c = await convertField(deps, spec, k, raw);
    const current = comparableOfItem(c.def.type, target.columns[k]);
    values[k] = c.monday;
    before[k] = hashComparable(k, current);
    after[k] = hashComparable(k, c.comparable);
    types[k] = c.def.type;
  }
  return { kind: "update", boardId: spec.id, itemId: target.id, values, before, after, types };
}

async function buildOptOutPlan(req: ChangeRequest, deps: PlanDeps): Promise<Plan> {
  const spec = req.board;
  const column = "interest_status";
  const conv = await convertField(deps, spec, column, OPT_OUT_STATUS_LABEL);
  const found = (await deps.api.findItemsByColumn(spec.id, spec.ownerColumn, req.nationalId)).filter(
    (i) => i.boardId === spec.id && i.state === "active",
  );
  // Ownership must be exact (string equality, leading zeros preserved); anything else is never touched.
  const owned = found.filter((i) => (i.columns[spec.ownerColumn]?.text ?? "").trim() === req.nationalId);
  const targets = owned
    .filter((i) => comparableOfItem(conv.def.type, i.columns[column]) !== conv.comparable)
    .map((i) => i.id);
  return {
    kind: "opt_out",
    boardId: spec.id,
    ownerColumn: spec.ownerColumn,
    ownerValue: req.nationalId,
    column,
    label: OPT_OUT_STATUS_LABEL,
    values: { [column]: conv.monday },
    targets,
    skippedOwnership: found.length - owned.length,
  };
}

export type Reconciled = { status: "applied"; itemId?: string } | { status: "not_applied" };

/** Decide, from monday's current state alone, whether a possibly-applied mutation took effect. */
export async function reconcile(api: MondayApi, intent: Intent): Promise<Reconciled> {
  const hashes = (item: MItem, types: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(types).map((c) => [c, hashComparable(c, comparableOfItem(types[c]!, item.columns[c]))]),
    );
  const eq = (a: Record<string, string>, b: Record<string, string>) => Object.keys(b).every((k) => a[k] === b[k]);

  if (intent.kind === "archive") {
    const item = await api.getItem(intent.itemId);
    if (!item || item.boardId !== intent.boardId) throw new ManualReviewError("RECONCILE_TARGET_UNREADABLE");
    if (item.state === "archived" || item.state === "deleted") return { status: "applied" };
    if (item.state === "active") return { status: "not_applied" };
    throw new ManualReviewError("RECONCILE_UNKNOWN_STATE");
  }

  if (intent.kind === "opt_out") {
    // Resumable: done iff every recorded target is already opted out. Anything still pending is
    // simply recomputed (idempotent) from freshly verified ownership on the retry.
    let pending = 0;
    for (const id of intent.targets) {
      const item = await api.getItem(id);
      if (!item || item.boardId !== intent.boardId) throw new ManualReviewError("RECONCILE_TARGET_UNREADABLE");
      if (item.state !== "active") continue;
      if ((item.columns[intent.ownerColumn]?.text ?? "").trim() !== intent.ownerValue)
        throw new ManualReviewError("RECONCILE_OWNERSHIP_CHANGED");
      if (comparableOfItem("status", item.columns[intent.column]) !== intent.label) pending++;
    }
    return pending === 0 ? { status: "applied" } : { status: "not_applied" };
  }

  if (intent.kind === "update") {
    const item = await api.getItem(intent.itemId);
    if (!item || item.boardId !== intent.boardId || item.state !== "active")
      throw new ManualReviewError("RECONCILE_TARGET_UNREADABLE");
    const now = hashes(item, intent.types);
    if (eq(now, intent.after)) return { status: "applied" };
    if (eq(now, intent.before)) return { status: "not_applied" };
    throw new ManualReviewError("RECONCILE_AMBIGUOUS"); // partial or third-party change
  }

  const items = (await api.findItemsByColumn(intent.boardId, intent.ownerColumn, intent.ownerValue)).filter(
    (i) => i.boardId === intent.boardId && i.state === "active" && (i.columns[intent.ownerColumn]?.text ?? "").trim() === intent.ownerValue,
  );
  const baseline = new Set(intent.baselineIds);
  const fresh = items.filter((i) => !baseline.has(i.id) && eq(hashes(i, intent.types), intent.after));
  if (fresh.length === 1) return { status: "applied", itemId: fresh[0]!.id };
  if (fresh.length === 0) return { status: "not_applied" };
  throw new ManualReviewError("RECONCILE_DUPLICATE_CREATE");
}
