import { describe, expect, it } from "vitest";
import { DeferredError } from "../src/errors";
import { BOARDS } from "../src/mapping/boards";
import { GRAD, NID, PARENT, addSub, careerRecord, world, type World } from "./harness";

const J = (o: Record<string, unknown>) => ({ schemaVersion: 1, ...o });
const upd = (w: World, newValue: string, existing: string, id?: string) =>
  addSub(w, { id, board: "תעסוקה", op: "עדכון", field: "job_title", existing, newValue, target: "400" });
const jobTitle = (w: World) => w.fake.col("400", "job_title");
const optOut = (w: World) =>
  addSub(w, { board: "תחומי עניין", op: "עדכון", tech: "__interest_opt_out__", json: J({ operation: "special", specialOperation: "interest_opt_out" }) });
const comm = (w: World, id: string, status: string) => w.fake.add(BOARDS.community.id, id, { alumni_id: NID, activity_type: "מרכז יזמות", interest_status: status });

describe("last executed approval wins", () => {
  it("two approved changes to the same field run sequentially; the last executed value is final", async () => {
    const w = world();
    careerRecord(w);
    // both requests were made when the title was "מעצבת"; B's original is therefore stale by the time it runs
    const a = upd(w, "מנהלת", "מעצבת");
    const b = upd(w, "סמנכ״לית", "מעצבת");
    expect((await w.exec.process(a)).status).toBe("applied");
    expect(jobTitle(w)).toBe("מנהלת");
    expect((await w.exec.process(b)).status).toBe("applied");
    expect(jobTitle(w)).toBe("סמנכ״לית");
    expect(w.fake.targetMutations().map((m) => m.args.values.job_title)).toEqual(["מנהלת", "סמנכ״לית"]);
  });

  it("concurrent changes to the same graduate/board never run in parallel (second is deferred, then applied)", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", "מעצבת");
    const b = upd(w, "B", "מעצבת");
    // slow the first target write so the second would overlap without the lock
    let inFlight = 0;
    let maxInFlight = 0;
    const orig = w.fake.changeColumns.bind(w.fake);
    w.fake.changeColumns = async (bd, id, v) => {
      if (bd === BOARDS.career.id) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      }
      return orig(bd, id, v);
    };
    const res = await Promise.allSettled([w.exec.process(a), w.exec.process(b)]);
    expect(maxInFlight).toBe(1);
    const deferred = res.filter((r) => r.status === "rejected" && r.reason instanceof DeferredError);
    expect(deferred).toHaveLength(1);
    // the deferred change is retried by the worker once the target is free
    w.store.enqueue(b, PARENT);
    w.store.enqueue(a, PARENT);
    w.clock.t += 10_000;
    await w.worker.drain();
    expect(jobTitle(w)).toBe("B"); // executed second ⇒ wins
  });

  it("the worker defers a busy change without counting it as a failed attempt, then runs it", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", "מעצבת");
    const b = upd(w, "B", "מעצבת");
    // A holds the lock mid-flight (claimed, lease valid)
    const changeA = w.fake.col(a, "text_mm90t835")!;
    w.store.claim(changeA, a, PARENT);
    expect(w.store.acquireLock(`${BOARDS.career.id}:${NID}`, changeA)).toBe(true);
    w.store.enqueue(b, PARENT);
    await w.worker.drain();
    expect(jobTitle(w)).toBe("מעצבת");
    expect(w.store.pendingJobCount()).toBe(1);
    // A finishes (releases lock); B proceeds
    const rowA = w.store.get(changeA)!;
    w.store.finish(changeA, rowA.lease_owner!, "applied");
    w.clock.t += 5_000;
    await w.worker.drain();
    expect(jobTitle(w)).toBe("B");
  });

  it("a crashed holder that may have a mutation in flight blocks later changes until it is recovered", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", "מעצבת");
    const b = upd(w, "B", "מעצבת");
    // A: killed right after the target write, before any state update
    w.fake.hooks.after = (_k, args) => {
      if (args.boardId === BOARDS.career.id) throw new Error("kill -9");
    };
    await w.exec.process(a);
    w.fake.hooks.after = undefined;
    const changeA = w.fake.col(a, "text_mm90t835")!;
    w.store.db.prepare("UPDATE changes SET state='processing', phase='mutating', lease_expires_at=0, lease_owner='dead' WHERE change_id=?").run(changeA);
    w.store.db.prepare("INSERT OR REPLACE INTO locks(key,change_id) VALUES(?,?)").run(`${BOARDS.career.id}:${NID}`, changeA);
    // B must NOT run before A is reconciled
    await expect(w.exec.process(b)).rejects.toBeInstanceOf(DeferredError);
    expect(jobTitle(w)).toBe("A");
    // recovery reconciles A (already applied), releases the lock, then B runs
    w.worker.recoverStale();
    w.store.enqueue(b, PARENT);
    await w.worker.drain();
    w.clock.t += 5_000;
    await w.worker.drain();
    expect(w.store.get(changeA)!.state).toBe("applied");
    expect(jobTitle(w)).toBe("B");
    expect(w.fake.targetMutations().filter((m) => m.args.values?.job_title === "A")).toHaveLength(1);
  });

  it("duplicate webhooks of an older, already-applied change never reapply it over a newer one", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", "מעצבת");
    const b = upd(w, "B", "A");
    await w.exec.process(a);
    await w.exec.process(b);
    expect(jobTitle(w)).toBe("B");
    for (let i = 0; i < 3; i++) expect(await w.exec.process(a)).toMatchObject({ status: "skipped", reason: "applied" });
    for (let i = 0; i < 3; i++) w.store.enqueue(a, PARENT);
    await w.worker.drain();
    expect(jobTitle(w)).toBe("B");
    expect(w.fake.targetMutations()).toHaveLength(2);
  });

  it("grouped update applies even when the originals have changed", async () => {
    const w = world();
    careerRecord(w);
    w.fake.items.get("400")!.columns.cluster = { type: "dropdown", text: "עיצוב אמנות ותרבות", value: { ids: [2] } };
    w.fake.items.get("400")!.columns.domain = { type: "dropdown", text: "תוכנה", value: { ids: [1] } };
    const s = addSub(w, {
      board: "תעסוקה", op: "עדכון", target: "400", tech: "__grouped_update__",
      json: J({ operation: "update", existingFields: { cluster: "טכנולוגיה והייטק", domain: "אחר" }, fields: { cluster: "טכנולוגיה והייטק", domain: "אחר" } }),
    });
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(w.fake.targetMutations()).toHaveLength(1);
    expect(w.fake.col("400", "domain")).toBe("אחר");
  });

  it("grouped update still requires target, ownership and valid values", async () => {
    const w = world();
    careerRecord(w, "400", { alumni_id: "555" });
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", target: "400", tech: "__grouped_update__", json: J({ fields: { cluster: "טכנולוגיה והייטק" } }) });
    expect(await w.exec.process(s)).toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    expect(w.fake.targetMutations()).toHaveLength(0);
  });

  it("opt-out after another approved update: the later opt-out wins and re-fetches fresh records", async () => {
    const w = world();
    comm(w, "600", "לא מעוניין");
    const update = addSub(w, { board: "תחומי עניין", op: "עדכון", target: "600", field: "interest_status", existing: "לא מעוניין", newValue: "מעוניין" });
    expect((await w.exec.process(update)).status).toBe("applied");
    expect(w.fake.col("600", "interest_status")).toBe("מעוניין");
    const o = optOut(w);
    expect((await w.exec.process(o)).status).toBe("applied");
    expect(w.fake.col("600", "interest_status")).toBe("לא מעוניין");
    expect(w.fake.targetMutations().map((m) => m.args.itemId)).toEqual(["600", "600"]);
  });

  it("an ordinary update executed after an opt-out wins over it", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    const o = optOut(w);
    const update = addSub(w, { board: "תחומי עניין", op: "עדכון", target: "600", field: "interest_status", existing: "מעוניין", newValue: "מעוניין" });
    await w.exec.process(o);
    expect(w.fake.col("600", "interest_status")).toBe("לא מעוניין");
    await w.exec.process(update);
    expect(w.fake.col("600", "interest_status")).toBe("מעוניין");
    // duplicate opt-out webhook does not undo the newer update
    expect(await w.exec.process(o)).toMatchObject({ status: "skipped", reason: "applied" });
    expect(w.fake.col("600", "interest_status")).toBe("מעוניין");
  });

  it("opt-out and a concurrent ordinary update on the same graduate are serialized", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    const o = optOut(w);
    const update = addSub(w, { board: "תחומי עניין", op: "עדכון", target: "600", field: "interest_status", existing: "מעוניין", newValue: "מעוניין" });
    const res = await Promise.allSettled([w.exec.process(o), w.exec.process(update)]);
    expect(res.filter((r) => r.status === "rejected" && r.reason instanceof DeferredError)).toHaveLength(1);
  });

  it("archive protections are unchanged: only the explicitly approved, verified record is archived", async () => {
    const w = world();
    careerRecord(w);
    careerRecord(w, "401", { company: "Yep" });
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: "400" }) });
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(w.fake.items.get("400")!.state).toBe("archived");
    expect(w.fake.items.get("401")!.state).toBe("active");
    const alumni = addSub(w, { board: "בוגרים", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: GRAD }) });
    expect(await w.exec.process(alumni)).toMatchObject({ code: "ARCHIVE_NOT_ALLOWED" });
    careerRecord(w, "402", { alumni_id: "555" });
    const other = addSub(w, { board: "תעסוקה", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: "402" }) });
    expect(await w.exec.process(other)).toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    expect(w.fake.items.get("402")!.state).toBe("active");
  });
});
