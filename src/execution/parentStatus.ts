import { text, type MondayApi } from "../domain";
import type { Logger } from "../logger";
import { LABELS, PARENT_BOARD_ID, PARENT_COLS, SUBITEM_BOARD_ID, SUB_COLS } from "../mapping/boards";
import type { Store } from "../store/store";

/**
 * Parent application status (color_mm9085gm) from each subitem's decision (color_mm90s5mz) and sync status (color_mm90k1tq).
 * A rejected subitem is marked בוצע (nothing is executed for it) so that "done" is uniform across subitems:
 *   1. no subitems                                          → טרם הוחל (default)
 *   2. at least one subitem not yet approved/rejected       → בתהליך
 *   3. every subitem (rejected ones included) is בוצע        → הושלם
 *   4. otherwise: nothing executed yet for the approved ones → טרם הוחל; any approved one started (running,
 *      failed, done) but not all finished                    → בתהליך
 * Only existing parent labels are used.
 */
export function deriveApplicationStatus(subs: Array<{ decision: string; sync: string }>): string {
  if (subs.length === 0) return LABELS.appNotApplied;
  if (subs.some((s) => s.decision !== LABELS.approved && s.decision !== LABELS.rejected)) return LABELS.appRunning;
  if (subs.every((s) => s.sync === LABELS.syncDone)) return LABELS.appDone;
  const started = subs.some((s) => s.decision === LABELS.approved && s.sync !== LABELS.syncNotDone && s.sync !== "");
  return started ? LABELS.appRunning : LABELS.appNotApplied;
}

/**
 * The parent column's labels have been renamed before. Each wanted status lists the existing labels that may
 * express it, in order of preference. Only labels that exist on the live column are ever written; nothing is created.
 */
const LABEL_CANDIDATES: Record<string, string[]> = {
  [LABELS.appRunning]: [LABELS.appRunning, "מתבצע"],
  [LABELS.appDone]: [LABELS.appDone, "בוצע"],
  [LABELS.appNotApplied]: [LABELS.appNotApplied],
};

export function resolveParentLabel(wanted: string, live: string[]): string | null {
  const have = new Set(live);
  return (LABEL_CANDIDATES[wanted] ?? [wanted]).find((l) => have.has(l)) ?? null;
}

/** One calculation from CURRENT monday state; writes only if the parent label differs. Returns the label. */
export async function syncParentOnce(api: MondayApi, parentId: string, liveLabels?: string[]): Promise<string | null> {
  const [parent, subs] = await Promise.all([api.getItem(parentId), api.listSubitems(parentId)]);
  if (!parent || parent.boardId !== PARENT_BOARD_ID) return null;
  // Rejected subitems are never executed: mark them בוצע (also backfills older rejected ones). Only the sync
  // column of REJECTED subitems is written; approved/pending subitems are never touched here.
  for (const sub of subs) {
    if (text(sub, SUB_COLS.decision) === LABELS.rejected && text(sub, SUB_COLS.sync) !== LABELS.syncDone) {
      await api.changeColumns(SUBITEM_BOARD_ID, sub.id, { [SUB_COLS.sync]: { label: LABELS.syncDone } });
      sub.columns[SUB_COLS.sync] = { type: "status", text: LABELS.syncDone, value: null };
    }
  }
  const labels =
    liveLabels ??
    ((await api.getBoardColumns(PARENT_BOARD_ID)).find((c) => c.id === PARENT_COLS.application)?.labels ?? []).map((l) => l.label);
  const wanted = deriveApplicationStatus(
    subs.map((s) => ({ decision: text(s, SUB_COLS.decision), sync: text(s, SUB_COLS.sync) })),
  );
  const label = resolveParentLabel(wanted, labels);
  if (!label) throw new Error("PARENT_STATUS_LABEL_MISSING");
  if (text(parent, PARENT_COLS.application) !== label) {
    // Only the application-status column is written; the reviewer's decisions are never touched.
    await api.changeColumns(PARENT_BOARD_ID, parentId, { [PARENT_COLS.application]: { label } });
  }
  return label;
}

/**
 * Serializes parent updates and guarantees "last request wins": every refresh request marks the parent dirty,
 * and whoever holds the (durable, leased) parent lock keeps recalculating from fresh monday state until no
 * newer request arrived. A stale calculation can therefore never be the final write.
 * Failures keep the parent dirty so a later sweep retries; they never affect the subitem result.
 */
export class ParentStatusSync {
  constructor(
    private readonly api: MondayApi,
    private readonly store: Store,
    private readonly log: Logger,
  ) {}

  async refresh(parentId: string | undefined | null): Promise<void> {
    if (!parentId) return;
    this.store.markParentDirty(parentId);
    await this.drain(parentId);
  }

  /** Retry parents left dirty by an API failure or a crashed holder. */
  async sweep(): Promise<number> {
    const ids = this.store.dirtyParents();
    for (const id of ids) await this.drain(id);
    return ids.length;
  }

  private async drain(parentId: string): Promise<void> {
    for (;;) {
      if (!this.store.tryLockParent(parentId)) return; // the holder will pick up our dirty mark
      let failed = false;
      try {
        while (this.store.takeParentDirty(parentId)) {
          try {
            const label = await syncParentOnce(this.api, parentId);
            this.log.info("parent_status_synced", { parentId, label });
          } catch (e) {
            this.store.markParentDirty(parentId); // keep for the sweeper
            this.log.warn("parent_status_update_failed", { parentId, err: e as Error, code: (e as { code?: string }).code });
            failed = true;
            break;
          }
        }
      } finally {
        this.store.unlockParent(parentId);
      }
      // A request that arrived between our last check and the unlock must not be lost.
      if (failed || !this.store.isParentDirty(parentId)) return;
    }
  }
}
