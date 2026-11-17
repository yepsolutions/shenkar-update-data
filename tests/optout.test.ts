import { describe, expect, it } from "vitest";
import { MondayRejectedError } from "../src/errors";
import { BOARDS } from "../src/mapping/boards";
import { lost } from "./fakeMonday";
import { NID, PARENT, addSub, world, type World } from "./harness";

const OPT = { schemaVersion: 1, operation: "special", specialOperation: "interest_opt_out" };
const optOut = (w: World, over: Record<string, unknown> = {}) =>
  addSub(w, { board: "תחומי עניין", op: "עדכון", tech: "__interest_opt_out__", json: OPT, ...over });
const comm = (w: World, id: string, status: string, owner = NID) =>
  w.fake.add(BOARDS.community.id, id, { alumni_id: owner, activity_type: "מרכז יזמות", interest_status: status });
const status = (w: World, id: string) => w.fake.col(id, "interest_status");
const writes = (w: World) => w.fake.targetMutations();
const syncOf = (w: World, sub: string) => w.fake.col(sub, "color_mm90k1tq");

describe("community interest opt-out", () => {
  it("no Community records: no source-board writes, change marked done", async () => {
    const w = world();
    const s = optOut(w);
    expect(await w.exec.process(s)).toMatchObject({ status: "applied" });
    expect(writes(w)).toHaveLength(0);
    expect(syncOf(w, s)).toBe("בוצע");
    expect(w.fake.col("100", "color_mm9085gm")).toBe("הושלם");
  });

  it("all records already לא מעוניין: no writes, change marked done", async () => {
    const w = world();
    comm(w, "600", "לא מעוניין");
    comm(w, "601", "לא מעוניין");
    const s = optOut(w);
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(writes(w)).toHaveLength(0);
    expect(syncOf(w, s)).toBe("בוצע");
  });

  it("updates only the records that are not yet opted out", async () => {
    const w = world();
    comm(w, "600", "לא מעוניין");
    comm(w, "601", "מעוניין");
    comm(w, "602", "השתתף בעבר"); // any other status is also set to opt-out
    const s = optOut(w);
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(writes(w).map((m) => m.args.itemId)).toEqual(["601", "602"]);
    expect([status(w, "600"), status(w, "601"), status(w, "602")]).toEqual(["לא מעוניין", "לא מעוניין", "לא מעוניין"]);
  });

  it("updates several records, only interest_status, never archives or deletes", async () => {
    const w = world();
    for (const id of ["600", "601", "602", "603"]) comm(w, id, "מעוניין");
    const s = optOut(w);
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(writes(w)).toHaveLength(4);
    for (const m of writes(w)) {
      expect(Object.keys(m.args.values)).toEqual(["interest_status"]);
      expect(m.args.boardId).toBe(BOARDS.community.id);
    }
    expect(w.fake.mutations.filter((m) => m.kind === "archive" || m.kind === "create")).toHaveLength(0);
    for (const id of ["600", "601", "602", "603"]) expect(w.fake.items.get(id)!.state).toBe("active");
  });

  it("never touches records of other graduates (ownership mismatch incl. leading-zero look-alikes)", async () => {
    const w = world();
    comm(w, "600", "מעוניין"); // ours
    comm(w, "601", "מעוניין", NID.replace(/^0+/, "")); // look-alike without leading zero
    comm(w, "602", "מעוניין", "999999999");
    comm(w, "603", "מעוניין", ""); // no owner → ambiguous
    const s = optOut(w, { target: "602" }); // an id in the request must be ignored entirely
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(writes(w).map((m) => m.args.itemId)).toEqual(["600"]);
    for (const id of ["601", "602", "603"]) expect(status(w, id)).toBe("מעוניין");
  });

  it("ownership that changes between planning and writing stops without modifying that record", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    comm(w, "601", "מעוניין");
    w.fake.hooks.after = (_k, a) => {
      if (a.itemId === "600") {
        w.fake.hooks.after = undefined;
        w.fake.items.get("601")!.columns.alumni_id!.text = "777"; // reassigned meanwhile
      }
    };
    const s = optOut(w);
    expect(await w.exec.process(s)).toMatchObject({ status: "manual_review", code: "OPT_OUT_OWNERSHIP_CHANGED" });
    expect(status(w, "600")).toBe("לא מעוניין");
    expect(status(w, "601")).toBe("מעוניין");
  });

  it.each([["הוספה"], ["מחיקה"]])("requires the operation label to be עדכון (rejects %s) and writes nothing", async (op) => {
    const w = world();
    comm(w, "600", "מעוניין");
    const s = optOut(w, { op: op as "הוספה" | "מחיקה" });
    expect(await w.exec.process(s)).toMatchObject({ status: "failed", code: "OPERATION_MISMATCH" });
    expect(w.fake.mutations.filter((m) => m.args.itemId === "600")).toHaveLength(0);
    expect(status(w, "600")).toBe("מעוניין");
  });

  it("is a graduate-wide operation on the Community board only", async () => {
    const w = world();
    const s = optOut(w, { board: "תעסוקה" });
    expect(await w.exec.process(s)).toMatchObject({ code: "OPT_OUT_WRONG_BOARD" });
    const bad = addSub(w, { board: "תחומי עניין", op: "עדכון", tech: "__interest_opt_out__", json: { schemaVersion: 1, operation: "special", specialOperation: "delete_everything" } });
    expect(await w.exec.process(bad)).toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("duplicate webhook deliveries (sequential and concurrent) write exactly once per record", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    comm(w, "601", "מעוניין");
    const s = optOut(w);
    const r = await Promise.all([w.exec.process(s), w.exec.process(s), w.exec.process(s)]);
    expect(r.filter((x) => x.status === "applied")).toHaveLength(1);
    expect(await w.exec.process(s)).toMatchObject({ status: "skipped", reason: "applied" });
    for (let i = 0; i < 3; i++) w.store.enqueue(s, PARENT);
    await w.worker.drain();
    expect(writes(w)).toHaveLength(2);
  });

  it("partial failure then retry: only the remaining record is written", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    comm(w, "601", "מעוניין");
    comm(w, "602", "מעוניין");
    w.fake.hooks.before = (_k, a) => {
      if (a.itemId === "601") {
        w.fake.hooks.before = undefined;
        throw new MondayRejectedError("ColumnValueException");
      }
    };
    const s = optOut(w);
    expect(await w.exec.process(s)).toMatchObject({ status: "failed" });
    expect(status(w, "600")).toBe("לא מעוניין");
    expect(status(w, "601")).toBe("מעוניין");
    expect(syncOf(w, s)).toBe("נכשל");
    expect(w.fake.col("100", "color_mm9085gm")).toBe("בתהליך"); // approved change failed ⇒ not הושלם
    // reviewer re-approves → duplicate-safe retry
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(writes(w).map((m) => m.args.itemId)).toEqual(["600", "601", "602"]); // 600 once; retry writes only 601, 602
    expect(writes(w).filter((m) => m.args.itemId === "600")).toHaveLength(1); // not re-written
    expect([status(w, "600"), status(w, "601"), status(w, "602")]).toEqual(["לא מעוניין", "לא מעוניין", "לא מעוניין"]);
    expect(syncOf(w, s)).toBe("בוצע");
    expect(w.fake.col("100", "color_mm9085gm")).toBe("הושלם"); // all approved changes now done
  });

  it("lost response after a write that DID apply: reconciled, finished without extra writes", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    w.fake.hooks.after = (k, a) => {
      if (a.itemId === "600") {
        w.fake.hooks.after = undefined;
        throw lost();
      }
    };
    const s = optOut(w);
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(writes(w)).toHaveLength(1);
  });

  it("lost response on a write that did NOT apply: failed, retry completes", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    w.fake.hooks.before = (_k, a) => {
      if (a.itemId === "600") {
        w.fake.hooks.before = undefined;
        throw lost();
      }
    };
    const s = optOut(w);
    expect(await w.exec.process(s)).toMatchObject({ status: "failed" });
    expect(status(w, "600")).toBe("מעוניין");
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(status(w, "600")).toBe("לא מעוניין");
  });

  it("crash midway: expired lease resumes, skipping done records and ignoring unrelated ones", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    comm(w, "601", "מעוניין");
    comm(w, "700", "מעוניין", "999999999"); // someone else's
    // hard crash after the first record was written
    w.fake.hooks.after = (_k, a) => {
      if (a.itemId === "600") throw new Error("kill -9");
    };
    const s = optOut(w);
    await w.exec.process(s);
    w.fake.hooks.after = undefined;
    const changeId = w.fake.col(s, "text_mm90t835")!;
    expect(w.store.get(changeId)!.intent).toBeTruthy();
    // model the dead worker: processing / mutating / lease expired
    w.store.db.prepare("UPDATE changes SET state='processing', phase='mutating', lease_expires_at=0, lease_owner='dead' WHERE change_id=?").run(changeId);
    // a NEW record appears for the graduate meanwhile; it is simply part of the graduate's records
    expect(w.worker.recoverStale()).toBe(1);
    await w.worker.drain();
    expect(w.store.get(changeId)!.state).toBe("applied");
    expect(status(w, "600")).toBe("לא מעוניין");
    expect(status(w, "601")).toBe("לא מעוניין");
    expect(status(w, "700")).toBe("מעוניין");
    expect(writes(w).filter((m) => m.args.itemId === "600")).toHaveLength(1);
    expect(writes(w).filter((m) => m.args.itemId === "700")).toHaveLength(0);
  });

  it("an ordinary interest_status update from the portal is still a regular single-field update", async () => {
    const w = world();
    comm(w, "600", "מעוניין");
    const s = addSub(w, { board: "תחומי עניין", op: "עדכון", target: "600", field: "interest_status", existing: "מעוניין", newValue: "לא מעוניין" });
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(status(w, "600")).toBe("לא מעוניין");
    expect(writes(w)).toHaveLength(1);
  });
});
