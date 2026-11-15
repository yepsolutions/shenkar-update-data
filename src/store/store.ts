/**
 * Durable state (SQLite, WAL, synchronous=FULL). Holds per-change idempotency records,
 * leases and the webhook job queue. All state transitions are guarded by lease ownership.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DB } from "node:sqlite";
import { LeaseLostError } from "../errors";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export type ChangeState = "processing" | "applied" | "failed" | "manual_review" | "dry_run";
export type Phase = "validating" | "mutating" | "mutated";

export interface ChangeRow {
  change_id: string;
  subitem_id: string;
  parent_id: string | null;
  state: ChangeState;
  phase: Phase;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number;
  intent: string | null;
  result_item_id: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  subitem_id: string;
  expected_parent_id: string | null;
  attempts: number;
}

export type ClaimResult =
  | { acquired: true; owner: string; row: ChangeRow }
  | { acquired: false; reason: "applied" | "manual_review" | "in_progress" | "max_attempts" | "subitem_mismatch" };

export class Store {
  readonly db: DB;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
    private readonly leaseMs = 120_000,
    private readonly maxAttempts = 5,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS changes(
        change_id TEXT PRIMARY KEY,
        subitem_id TEXT NOT NULL,
        parent_id TEXT,
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        intent TEXT,
        result_item_id TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subitem_id TEXT NOT NULL,
        expected_parent_id TEXT,
        run_after INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        locked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS locks(
        key TEXT PRIMARY KEY,
        change_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parent_sync(
        parent_id TEXT PRIMARY KEY,
        dirty INTEGER NOT NULL DEFAULT 0,
        lock_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_pending ON jobs(subitem_id) WHERE state='pending';
    `);
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get(changeId: string): ChangeRow | undefined {
    return this.db.prepare("SELECT * FROM changes WHERE change_id=?").get(changeId) as ChangeRow | undefined;
  }

  /** Atomically claim a change for processing. Exactly one caller wins while the lease is valid. */
  claim(changeId: string, subitemId: string, parentId: string | null): ClaimResult {
    return this.tx<ClaimResult>(() => {
      const now = this.now();
      const owner = randomUUID();
      const row = this.get(changeId);
      if (!row) {
        this.db
          .prepare(
            `INSERT INTO changes(change_id,subitem_id,parent_id,state,phase,attempts,lease_owner,lease_expires_at,created_at,updated_at)
             VALUES(?,?,?,'processing','validating',1,?,?,?,?)`,
          )
          .run(changeId, subitemId, parentId, owner, now + this.leaseMs, now, now);
        return { acquired: true, owner, row: this.get(changeId)! };
      }
      // The same CHG id on a different subitem is a duplicate/forged identifier: never process.
      if (row.subitem_id !== subitemId) return { acquired: false, reason: "subitem_mismatch" };
      if (row.state === "applied") return { acquired: false, reason: "applied" };
      if (row.state === "manual_review") return { acquired: false, reason: "manual_review" };
      if (row.state === "processing" && row.lease_expires_at > now) return { acquired: false, reason: "in_progress" };
      if (row.state === "failed" && row.attempts >= this.maxAttempts) return { acquired: false, reason: "max_attempts" };

      // failed / dry_run → restart from validation; expired processing lease → resume at recorded phase.
      const phase: Phase = row.state === "processing" ? row.phase : "validating";
      const intent = row.state === "processing" ? row.intent : null;
      this.db
        .prepare(
          `UPDATE changes SET state='processing', phase=?, intent=?, attempts=attempts+1, lease_owner=?,
             lease_expires_at=?, error_code=NULL, parent_id=COALESCE(?,parent_id), updated_at=? WHERE change_id=?`,
        )
        .run(phase, intent, owner, now + this.leaseMs, parentId, now, changeId);
      return { acquired: true, owner, row: this.get(changeId)! };
    });
  }

  private guarded(changeId: string, owner: string, sql: string, params: unknown[]) {
    const r = this.db
      .prepare(`UPDATE changes SET ${sql}, updated_at=? WHERE change_id=? AND lease_owner=? AND state='processing'`)
      .run(...(params as any[]), this.now(), changeId, owner);
    if (Number(r.changes) === 0) throw new LeaseLostError();
  }

  /**
   * Per-target lock (key = board + graduate) so approved changes touching the same records run strictly
   * one at a time. A holder is superseded only when it has finished, or when its lease expired while it
   * had not yet started mutating; a holder that may have a mutation in flight blocks until it is recovered.
   */
  acquireLock(key: string, changeId: string): boolean {
    return this.tx(() => {
      const now = this.now();
      const h = this.db
        .prepare(
          "SELECT l.change_id AS change_id, c.state AS state, c.phase AS phase, c.lease_expires_at AS lease FROM locks l LEFT JOIN changes c ON c.change_id=l.change_id WHERE l.key=?",
        )
        .get(key) as { change_id: string; state: string | null; phase: string | null; lease: number | null } | undefined;
      const free =
        !h ||
        h.change_id === changeId ||
        h.state === null ||
        h.state !== "processing" ||
        ((h.lease ?? 0) <= now && h.phase === "validating");
      if (!free) return false;
      this.db.prepare("INSERT INTO locks(key,change_id) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET change_id=excluded.change_id").run(key, changeId);
      return true;
    });
  }

  renew(changeId: string, owner: string) {
    this.guarded(changeId, owner, "lease_expires_at=?", [this.now() + this.leaseMs]);
  }

  /** Persist the plan BEFORE issuing the monday mutation. */
  beginMutation(changeId: string, owner: string, intent: unknown) {
    this.guarded(changeId, owner, "phase='mutating', intent=?, lease_expires_at=?", [
      JSON.stringify(intent),
      this.now() + this.leaseMs,
    ]);
  }

  clearIntent(changeId: string, owner: string) {
    this.guarded(changeId, owner, "phase='validating', intent=NULL", []);
  }

  setMutated(changeId: string, owner: string, resultItemId: string | null) {
    this.guarded(changeId, owner, "phase='mutated', result_item_id=COALESCE(?,result_item_id)", [resultItemId]);
  }

  finish(changeId: string, owner: string, state: Exclude<ChangeState, "processing">, code: string | null = null) {
    this.guarded(changeId, owner, "state=?, error_code=?, lease_owner=NULL, lease_expires_at=0", [state, code]);
    this.db.prepare("DELETE FROM locks WHERE change_id=?").run(changeId);
  }

  /** Give the claim back (transient error before any unreconciled mutation); phase/intent are kept. */
  release(changeId: string, owner: string) {
    this.db
      .prepare("UPDATE changes SET lease_expires_at=0, updated_at=? WHERE change_id=? AND lease_owner=? AND state='processing'")
      .run(this.now(), changeId, owner);
  }

  /** Operator resolution of a manual_review (or any) change after verifying monday by hand. */
  resolveManually(changeId: string, outcome: "applied" | "not_applied"): boolean {
    const state = outcome === "applied" ? "applied" : "failed";
    const code = outcome === "applied" ? "MANUALLY_RESOLVED" : "MANUALLY_RESOLVED_NOT_APPLIED";
    const r = this.db
      .prepare(
        "UPDATE changes SET state=?, phase='validating', intent=NULL, error_code=?, lease_owner=NULL, lease_expires_at=0, attempts=0, updated_at=? WHERE change_id=? AND state IN ('manual_review','failed')",
      )
      .run(state, code, this.now(), changeId);
    this.db.prepare("DELETE FROM locks WHERE change_id=?").run(changeId);
    return Number(r.changes) > 0;
  }

  staleProcessing(): ChangeRow[] {
    return this.db
      .prepare("SELECT * FROM changes WHERE state='processing' AND lease_expires_at<=?")
      .all(this.now()) as unknown as ChangeRow[];
  }

  // ---- job queue -------------------------------------------------------

  /** Durable enqueue; duplicates for the same subitem collapse into one pending job. */
  enqueue(subitemId: string, expectedParentId: string | null): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs(subitem_id,expected_parent_id,run_after,state) VALUES(?,?,?, 'pending')",
      )
      .run(subitemId, expectedParentId, this.now());
  }

  takeJob(): JobRow | undefined {
    return this.tx(() => {
      const now = this.now();
      // revive jobs whose worker died
      this.db
        .prepare("UPDATE jobs SET state='pending' WHERE state='running' AND locked_until<=? AND NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.subitem_id=jobs.subitem_id AND j2.state='pending')")
        .run(now);
      const j = this.db
        .prepare("SELECT id,subitem_id,expected_parent_id,attempts FROM jobs WHERE state='pending' AND run_after<=? ORDER BY id LIMIT 1")
        .get(now) as unknown as JobRow | undefined;
      if (!j) return undefined;
      this.db.prepare("UPDATE jobs SET state='running', locked_until=? WHERE id=?").run(now + this.leaseMs * 2, j.id);
      return j;
    });
  }

  completeJob(id: number) {
    this.db.prepare("DELETE FROM jobs WHERE id=?").run(id);
  }

  retryJob(id: number, delayMs: number) {
    // If a fresh pending job for the same subitem exists, drop this one instead.
    const j = this.db.prepare("SELECT subitem_id FROM jobs WHERE id=?").get(id) as { subitem_id: string } | undefined;
    if (!j) return;
    const dup = this.db.prepare("SELECT 1 AS x FROM jobs WHERE subitem_id=? AND state='pending'").get(j.subitem_id);
    if (dup) {
      this.completeJob(id);
      return;
    }
    this.db
      .prepare("UPDATE jobs SET state='pending', attempts=attempts+1, run_after=? WHERE id=?")
      .run(this.now() + delayMs, id);
  }

  /** Re-queue a job that could not start because the target is busy; does not count as a failed attempt. */
  deferJob(id: number, delayMs: number) {
    const j = this.db.prepare("SELECT subitem_id FROM jobs WHERE id=?").get(id) as { subitem_id: string } | undefined;
    if (!j) return;
    const dup = this.db.prepare("SELECT 1 AS x FROM jobs WHERE subitem_id=? AND state='pending'").get(j.subitem_id);
    if (dup) return this.completeJob(id);
    this.db.prepare("UPDATE jobs SET state='pending', run_after=? WHERE id=?").run(this.now() + delayMs, id);
  }

  // ---- parent status sync (see ParentStatusSync) ------------------------

  markParentDirty(parentId: string) {
    this.db
      .prepare("INSERT INTO parent_sync(parent_id,dirty) VALUES(?,1) ON CONFLICT(parent_id) DO UPDATE SET dirty=1")
      .run(parentId);
  }

  /** Atomically consume the dirty flag; true if there was a pending request. */
  takeParentDirty(parentId: string): boolean {
    return Number(this.db.prepare("UPDATE parent_sync SET dirty=0 WHERE parent_id=? AND dirty=1").run(parentId).changes) > 0;
  }

  isParentDirty(parentId: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM parent_sync WHERE parent_id=? AND dirty=1").get(parentId);
  }

  /** Short leased lock so a crashed holder cannot block the parent forever. */
  tryLockParent(parentId: string, leaseMs = 30_000): boolean {
    return this.tx(() => {
      const now = this.now();
      this.db.prepare("INSERT OR IGNORE INTO parent_sync(parent_id,dirty,lock_until) VALUES(?,0,0)").run(parentId);
      const r = this.db.prepare("UPDATE parent_sync SET lock_until=? WHERE parent_id=? AND lock_until<=?").run(now + leaseMs, parentId, now);
      return Number(r.changes) > 0;
    });
  }

  unlockParent(parentId: string) {
    this.db.prepare("UPDATE parent_sync SET lock_until=0 WHERE parent_id=?").run(parentId);
  }

  dirtyParents(): string[] {
    return (this.db.prepare("SELECT parent_id FROM parent_sync WHERE dirty=1 AND lock_until<=?").all(this.now()) as Array<{ parent_id: string }>).map((r) => r.parent_id);
  }

  pendingJobCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n);
  }
}
