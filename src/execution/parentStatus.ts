import { text, type MondayApi } from "../domain";
import type { Logger } from "../logger";
import { LABELS, PARENT_BOARD_ID, PARENT_COLS, SUB_COLS } from "../mapping/boards";
import type { Store } from "../store/store";

/**
 * Parent application status (color_mm9085gm) from the subitems' decision and sync status, in priority order:
 *   1. any (non-rejected) subitem נכשל         → תקוע
 *   2. any (non-rejected) subitem בתהליך       → מתבצע
 *   3. there are subitems and ALL were rejected → בוטל
 *   4. every non-rejected subitem בוצע          → בוצע (rejected siblings are ignored; a subitem still
 *      pending approval is not בוצע, so it prevents this)
 *   5. anything else (e.g. טרם בוצע)            → טרם הוחל
 * Rejected subitems are never executed, so they are neither failures nor blockers. Only existing labels are used.
 */
export function deriveApplicationStatus(subs: Array<{ decision: string; sync: string }>): string {
  const live = subs.filter((s) => s.decision !== LABELS.rejected);
  if (live.some((s) => s.sync === LABELS.syncFailed)) return LABELS.appStuck;
  if (live.some((s) => s.sync === LABELS.syncRunning)) return LABELS.appRunning;
  if (subs.length > 0 && live.length === 0) return LABELS.appCancelled;
  if (live.length > 0 && live.every((s) => s.decision === LABELS.approved && s.sync === LABELS.syncDone))
    return LABELS.appDone;
  return LABELS.appNotApplied;
}

/** One calculation from CURRENT monday state; writes only if the parent label differs. Returns the label. */
export async function syncParentOnce(api: MondayApi, parentId: string): Promise<string | null> {
  const [parent, subs] = await Promise.all([api.getItem(parentId), api.listSubitems(parentId)]);
  if (!parent || parent.boardId !== PARENT_BOARD_ID) return null;
  const label = deriveApplicationStatus(
    subs.map((s) => ({ decision: text(s, SUB_COLS.decision), sync: text(s, SUB_COLS.sync) })),
  );
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
    private readonly dryRun: boolean,
  ) {}

  async refresh(parentId: string | undefined | null): Promise<void> {
    if (this.dryRun || !parentId) return;
    this.store.markParentDirty(parentId);
    await this.drain(parentId);
  }

  /** Retry parents left dirty by an API failure or a crashed holder. */
  async sweep(): Promise<number> {
    if (this.dryRun) return 0;
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
            this.log.warn("parent_status_update_failed", { parentId, err: e as Error });
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
