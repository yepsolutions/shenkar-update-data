import { DeferredError } from "../errors";
import type { Logger } from "../logger";
import type { Store } from "../store/store";
import type { Executor } from "./executor";

export class Worker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly exec: Executor,
    private readonly log: Logger,
    private readonly pollMs = 1000,
    private readonly maxJobAttempts = 8,
  ) {}

  /** Process every due job once. Returns the number handled. Exposed for tests and the poll loop. */
  async drain(): Promise<number> {
    let n = 0;
    for (;;) {
      const job = this.store.takeJob();
      if (!job) return n;
      n++;
      try {
        if (job.kind === "parent") await this.exec.refreshParentOfSubitem(job.subitem_id);
        else await this.exec.process(job.subitem_id, job.expected_parent_id);
        this.store.completeJob(job.id);
      } catch (e) {
        if (e instanceof DeferredError) {
          this.store.deferJob(job.id, 2000);
          continue;
        }
        if (job.attempts + 1 >= this.maxJobAttempts) {
          this.log.error("job_dropped", { subitemId: job.subitem_id, err: e as Error });
          this.store.completeJob(job.id);
        } else {
          const delay = Math.min(5 * 60_000, 2000 * 2 ** job.attempts);
          this.log.warn("job_retry_scheduled", { subitemId: job.subitem_id, err: e as Error });
          this.store.retryJob(job.id, delay);
        }
      }
    }
  }

  /** Re-enqueue changes whose worker died mid-flight (expired lease). */
  recoverStale(): number {
    const stale = this.store.staleProcessing();
    for (const r of stale) this.store.enqueue(r.subitem_id, r.parent_id);
    if (stale.length) this.log.warn("recovering_stale_changes", { count: stale.length });
    return stale.length;
  }

  start() {
    this.recoverStale();
    void this.exec.sweepParents().catch(() => {});
    let ticks = 0;
    this.timer = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        if (++ticks % 30 === 0) {
          this.recoverStale();
          await this.exec.sweepParents();
        }
        await this.drain();
      } catch (e) {
        this.log.error("worker_loop_error", { err: e as Error });
      } finally {
        this.running = false;
      }
    }, this.pollMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
