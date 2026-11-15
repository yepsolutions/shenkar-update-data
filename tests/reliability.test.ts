import { describe, expect, it } from "vitest";
import { BOARDS } from "../src/mapping/boards";
import { NID, PARENT, addSub, careerRecord, world } from "./harness";
import { lost } from "./fakeMonday";
import { MondayUncertainError } from "../src/errors";

const onTarget = (a: any) => a?.boardId !== "5107603016" && a?.boardId !== "5107220927";
const createPayload = JSON.stringify({ schemaVersion: 1, fields: { company: "Studio ABC", job_title: "מעצבת מוצר" } });
const careers = (w: ReturnType<typeof world>) => [...w.fake.items.values()].filter((i) => i.boardId === BOARDS.career.id);
const statusWrites = (w: ReturnType<typeof world>, sub: string) =>
  w.fake.mutations.filter((m) => m.kind === "change" && m.args.itemId === sub && m.args.values.color_mm90k1tq);

describe("idempotency", () => {
  it("duplicate approved events apply a create exactly once", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: createPayload });
    expect((await w.exec.process(s)).status).toBe("applied");
    // duplicate webhooks (e.g. monday retries), even after the subitem already shows בוצע
    for (let i = 0; i < 3; i++) expect(await w.exec.process(s)).toMatchObject({ status: "skipped", reason: "applied" });
    expect(careers(w)).toHaveLength(1);
  });

  it("concurrent processing of the same change is prevented by the lease", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    const results = await Promise.all([w.exec.process(s), w.exec.process(s), w.exec.process(s)]);
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(w.fake.targetMutations()).toHaveLength(1);
  });

  it("the same CHG id on a different subitem is refused", async () => {
    const w = world();
    careerRecord(w);
    const a = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400", changeId: "CHG-REQ-AB12CD34-777" });
    const b = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "X", newValue: "Z", target: "400", changeId: "CHG-REQ-AB12CD34-777" });
    await w.exec.process(a);
    expect(await w.exec.process(b)).toMatchObject({ status: "skipped", reason: "subitem_mismatch" });
    expect(w.fake.col("400", "company")).toBe("X");
  });

  it("worker drains duplicate jobs without double-applying", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: createPayload });
    for (let i = 0; i < 4; i++) w.store.enqueue(s, PARENT);
    await w.worker.drain();
    w.store.enqueue(s, PARENT);
    await w.worker.drain();
    expect(careers(w)).toHaveLength(1);
    expect(w.store.pendingJobCount()).toBe(0);
  });
});

describe("crash and uncertain outcomes", () => {
  it("create succeeded but response lost: reconciles and does NOT create a duplicate", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: createPayload });
    w.fake.hooks.after = (kind) => {
      if (kind === "create") {
        w.fake.hooks.after = undefined;
        throw lost();
      }
    };
    const out = await w.exec.process(s);
    expect(out.status).toBe("applied");
    expect(careers(w)).toHaveLength(1);
    expect(w.fake.col(s, "text_mm90g839")).toBe(careers(w)[0]!.id);
  });

  it("create not applied and response lost: retried exactly once after verification", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: createPayload });
    w.fake.hooks.before = (kind) => {
      if (kind === "create") {
        w.fake.hooks.before = undefined;
        throw new MondayUncertainError("timeout");
      }
    };
    const out = await w.exec.process(s);
    expect(out).toMatchObject({ status: "failed", code: "MUTATION_FAILED_NOT_APPLIED" });
    expect(careers(w)).toHaveLength(0);
    // reviewer re-approves → new webhook → safe retry
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(careers(w)).toHaveLength(1);
  });

  it("recovery after kill between mutation and status write finalizes without re-mutating", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "job_title", existing: "מעצבת", newValue: "מנהלת עיצוב", target: "400" });
    // First run: the status write after the mutation fails transiently (simulating a crash before sync update).
    let failStatus = true;
    const origChange = w.fake.changeColumns.bind(w.fake);
    w.fake.changeColumns = async (b, i, v) => {
      if (failStatus && v.color_mm90k1tq && (v.color_mm90k1tq as any).label === "בוצע") throw new MondayUncertainError("down");
      return origChange(b, i, v);
    };
    await expect(w.exec.process(s)).rejects.toThrow();
    expect(w.fake.col("400", "job_title")).toBe("מנהלת עיצוב");
    const mutationsBefore = w.fake.targetMutations().length;
    failStatus = false;
    const out = await w.exec.process(s);
    expect(out.status).toBe("applied");
    expect(w.fake.targetMutations()).toHaveLength(mutationsBefore); // no second update
    expect(w.fake.col(s, "color_mm90k1tq")).toBe("בוצע");
  });

  it("expired lease with intent recorded: reconcile → applied, no duplicate create", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: createPayload });
    // Worker A: kill the process right after create() returns by making the post-create DB write explode.
    const realSetMutated = w.store.setMutated.bind(w.store);
    w.store.setMutated = () => {
      throw new (class Kill extends Error {})("kill -9");
    };
    await w.exec.process(s).catch(() => {});
    w.store.setMutated = realSetMutated;
    // handleError recorded manual_review for the unknown error during mutation; model a TRUE crash instead:
    // reset the row to a crashed worker's state (processing, phase=mutating, lease expired).
    const changeId = (await w.fake.getItem(s))!.columns.text_mm90t835!.text!;
    const row = w.store.get(changeId)!;
    w.store.db.prepare("UPDATE changes SET state='processing', phase='mutating', lease_expires_at=0, lease_owner='dead' WHERE change_id=?").run(changeId);
    expect(careers(w)).toHaveLength(1);
    expect(row.intent).toBeTruthy();
    w.worker.recoverStale();
    await w.worker.drain();
    expect(careers(w)).toHaveLength(1);
    expect(w.store.get(changeId)!.state).toBe("applied");
    expect(w.fake.col(s, "text_mm90g839")).toBe(careers(w)[0]!.id);
  });

  it("expired lease with intent, create never happened: retries once safely", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: createPayload });
    w.fake.hooks.before = (k, a) => {
      if (k === "create") throw new Error("killed before request");
    };
    await w.exec.process(s).catch(() => {});
    w.fake.hooks.before = undefined;
    const changeId = (await w.fake.getItem(s))!.columns.text_mm90t835!.text!;
    w.store.db.prepare("UPDATE changes SET state='processing', phase='mutating', lease_expires_at=0 WHERE change_id=?").run(changeId);
    w.store.enqueue(s, PARENT);
    await w.worker.drain();
    expect(careers(w)).toHaveLength(1);
  });

  it("ambiguous update outcome (third-party change) → manual review, no retry", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "job_title", existing: "מעצבת", newValue: "מנהלת עיצוב", target: "400" });
    w.fake.hooks.after = (_k, a) => {
      if (!onTarget(a)) return;
      w.fake.hooks.after = undefined;
      w.fake.items.get("400")!.columns.job_title!.text = "מישהו אחר שינה"; // someone else edits concurrently
      throw lost();
    };
    const out = await w.exec.process(s);
    expect(out).toMatchObject({ status: "manual_review", code: "RECONCILE_AMBIGUOUS" });
    // later duplicate webhooks never retry
    const m = w.fake.targetMutations().length;
    expect(await w.exec.process(s)).toMatchObject({ status: "skipped", reason: "manual_review" });
    expect(w.fake.targetMutations()).toHaveLength(m);
    expect(w.fake.col(s, "color_mm90k1tq")).toBe("נכשל");
  });

  it("archive succeeded but response lost: verified via item state, not archived twice", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "400" });
    w.fake.hooks.after = (k) => {
      if (k === "archive") throw lost();
    };
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(w.fake.mutations.filter((m) => m.kind === "archive")).toHaveLength(1);
  });

  it("archive not applied + lost response: nothing archived, marked failed, retry works", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "400" });
    w.fake.hooks.before = (k) => {
      if (k === "archive") {
        w.fake.hooks.before = undefined;
        throw lost();
      }
    };
    expect(await w.exec.process(s)).toMatchObject({ status: "failed" });
    expect(w.fake.items.get("400")!.state).toBe("active");
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(w.fake.items.get("400")!.state).toBe("archived");
  });

  it("monday definitively rejecting a mutation → failed, never applied", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    const { MondayRejectedError } = await import("../src/errors");
    w.fake.hooks.before = (k, a) => {
      if (a.boardId === BOARDS.career.id) throw new MondayRejectedError("ColumnValueException");
    };
    expect(await w.exec.process(s)).toMatchObject({ status: "failed", code: "MONDAY_REJECTED_ColumnValueException" });
    expect(w.fake.col("400", "company")).toBe("Atera");
    expect(statusWrites(w, s).pop()!.args.values.color_mm90k1tq.label).toBe("נכשל");
  });

  it("transient read failure releases the claim and the job retries later", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    const { MondayTransientError } = await import("../src/errors");
    const orig = w.fake.findItemsByColumn.bind(w.fake);
    let fail = true;
    w.fake.findItemsByColumn = async (...a) => {
      if (fail) throw new MondayTransientError("503");
      return orig(...a);
    };
    w.store.enqueue(s, PARENT);
    await w.worker.drain();
    expect(w.fake.targetMutations()).toHaveLength(0);
    expect(w.store.pendingJobCount()).toBe(1); // scheduled for retry
    fail = false;
    w.clock.t += 10 * 60_000;
    await w.worker.drain();
    expect(w.fake.col("400", "company")).toBe("X");
  });

  it("a failed change is retriable only up to MAX_ATTEMPTS", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "role_status", existing: "נוכחי", newValue: "לא-תווית", target: "400" });
    const outs = [];
    for (let i = 0; i < 7; i++) outs.push((await w.exec.process(s)).status);
    expect(outs.slice(0, 5).every((o) => o === "failed")).toBe(true);
    expect(outs[5]).toBe("skipped");
  });
});

void NID;
