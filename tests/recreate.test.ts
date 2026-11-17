import { describe, expect, it } from "vitest";
import { MondayTransientError } from "../src/errors";
import { BOARDS } from "../src/mapping/boards";
import { NID, PARENT, addSub, careerRecord, world, type World } from "./harness";

const payload = JSON.stringify({ schemaVersion: 1, fields: { company: "Studio ABC", job_title: "מעצבת מוצר" } });
const createSub = (w: World) => addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: payload });
const careers = (w: World, state = "active") => [...w.fake.items.values()].filter((i) => i.boardId === BOARDS.career.id && i.state === state);
const creates = (w: World) => w.fake.mutations.filter((m) => m.kind === "create");

describe("applied CREATE whose record disappeared is created again", () => {
  it("record still present: a repeated event does nothing (no duplicate)", async () => {
    const w = world();
    const s = createSub(w);
    expect((await w.exec.process(s)).status).toBe("applied");
    for (let i = 0; i < 3; i++) expect(await w.exec.process(s)).toMatchObject({ status: "skipped", reason: "applied" });
    expect(creates(w)).toHaveLength(1);
    expect(careers(w)).toHaveLength(1);
  });

  it("record deleted in monday: the next approval event creates it again and updates the subitem", async () => {
    const w = world();
    const s = createSub(w);
    await w.exec.process(s);
    const firstId = careers(w)[0]!.id;
    w.fake.items.delete(firstId); // user deleted it on the board
    w.fake.items.get(s)!.columns.color_mm90k1tq!.text = "טרם בוצע"; // and reset the sync status
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(creates(w)).toHaveLength(2);
    const now = careers(w);
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(firstId);
    expect(now[0]!.columns.alumni_id!.text).toBe(NID);
    expect(w.fake.col(s, "text_mm90g839")).toBe(now[0]!.id);
    expect(w.fake.col(s, "color_mm90k1tq")).toBe("בוצע");
    // and once it exists again, further events are skipped
    expect(await w.exec.process(s)).toMatchObject({ status: "skipped", reason: "applied" });
    expect(creates(w)).toHaveLength(2);
  });

  it("record archived or marked deleted counts as missing", async () => {
    for (const state of ["archived", "deleted"]) {
      const w = world();
      const s = createSub(w);
      await w.exec.process(s);
      w.fake.items.get(careers(w)[0]!.id)!.state = state;
      expect((await w.exec.process(s)).status).toBe("applied");
      expect(careers(w)).toHaveLength(1);
      expect(creates(w)).toHaveLength(2);
    }
  });

  it("the record moved to another board counts as missing from the expected board", async () => {
    const w = world();
    const s = createSub(w);
    await w.exec.process(s);
    w.fake.items.get(careers(w)[0]!.id)!.boardId = BOARDS.education.id;
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(careers(w)).toHaveLength(1);
  });

  it("two events at once after the deletion create exactly one new record", async () => {
    const w = world();
    const s = createSub(w);
    await w.exec.process(s);
    w.fake.items.delete(careers(w)[0]!.id);
    const r = await Promise.all([w.exec.process(s), w.exec.process(s), w.exec.process(s)]);
    expect(r.filter((x) => x.status === "applied")).toHaveLength(1);
    expect(creates(w)).toHaveLength(2);
    expect(careers(w)).toHaveLength(1);
  });

  it("works through the webhook worker queue as well", async () => {
    const w = world();
    const s = createSub(w);
    w.store.enqueue(s, PARENT);
    await w.worker.drain();
    w.fake.items.delete(careers(w)[0]!.id);
    for (let i = 0; i < 3; i++) w.store.enqueue(s, PARENT);
    await w.worker.drain();
    expect(creates(w)).toHaveLength(2);
    expect(careers(w)).toHaveLength(1);
  });

  it("a monday read error during the check changes nothing and the job is retried", async () => {
    const w = world();
    const s = createSub(w);
    await w.exec.process(s);
    const id = careers(w)[0]!.id;
    w.fake.items.delete(id);
    const orig = w.fake.getItem.bind(w.fake);
    let fail = true;
    w.fake.getItem = async (x) => {
      if (fail && x === id) throw new MondayTransientError("503");
      return orig(x);
    };
    w.store.enqueue(s, PARENT);
    await w.worker.drain();
    expect(creates(w)).toHaveLength(1);
    expect(w.store.pendingJobCount()).toBe(1);
    fail = false;
    w.clock.t += 10 * 60_000;
    await w.worker.drain();
    expect(creates(w)).toHaveLength(2);
  });

  it("updates, deletes and opt-outs that were applied are NEVER re-applied", async () => {
    const w = world();
    careerRecord(w);
    const u = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    const del = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "400" });
    await w.exec.process(u);
    await w.exec.process(del);
    w.fake.items.get("400")!.state = "active"; // restored by hand
    w.fake.items.get("400")!.columns.company!.text = "מישהו שינה";
    const n = w.fake.targetMutations().length;
    expect(await w.exec.process(u)).toMatchObject({ status: "skipped", reason: "applied" });
    expect(await w.exec.process(del)).toMatchObject({ status: "skipped", reason: "applied" });
    expect(w.fake.targetMutations()).toHaveLength(n);
    expect(w.fake.col("400", "company")).toBe("מישהו שינה");
  });
});

describe("worker.kick (serverless hosts only give CPU during a request)", () => {
  it("processes queued jobs before returning, and concurrent kicks share one pass", async () => {
    const w = world();
    const s = createSub(w);
    w.store.enqueue(s, PARENT);
    await Promise.all([w.worker.kick(5000), w.worker.kick(5000)]);
    expect(creates(w)).toHaveLength(1);
    expect(w.store.pendingJobCount()).toBe(0);
  });
});
