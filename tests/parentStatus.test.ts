import { describe, expect, it } from "vitest";
import { deriveApplicationStatus, syncParentOnce } from "../src/execution/parentStatus";
import { MondayUncertainError } from "../src/errors";
import { BOARDS, PARENT_BOARD_ID } from "../src/mapping/boards";
import { PARENT, addSub, careerRecord, world, type World } from "./harness";

const A = "מאושר";
const R = "נדחה";
const P = "ממתין לאישור";
const NOT = "טרם בוצע";
const RUN = "בתהליך";
const DONE = "בוצע";
const FAIL = "נכשל";
const d = (...subs: Array<[string, string]>) => deriveApplicationStatus(subs.map(([decision, sync]) => ({ decision, sync })));

describe("deriveApplicationStatus (decision + execution)", () => {
  it("default: no subitems ⇒ טרם הוחל", () => {
    expect(d()).toBe("טרם הוחל");
  });
  it("a subitem not yet approved/rejected ⇒ בתהליך (whatever the others are)", () => {
    expect(d([P, NOT])).toBe("בתהליך");
    expect(d([A, DONE], [P, NOT])).toBe("בתהליך");
    expect(d([R, NOT], [P, NOT])).toBe("בתהליך");
    expect(d([A, NOT], [P, NOT])).toBe("בתהליך");
    expect(d(["", NOT])).toBe("בתהליך");
  });
  it("all approved ones בוצע ⇒ הושלם; rejected ones (טרם בוצע) are ignored", () => {
    expect(d([A, DONE])).toBe("הושלם");
    expect(d([A, DONE], [A, DONE], [A, DONE])).toBe("הושלם");
    expect(d([A, DONE], [R, NOT])).toBe("הושלם");
    expect(d([A, DONE], [A, DONE], [R, NOT], [R, NOT])).toBe("הושלם");
  });
  it("all rejected ⇒ הושלם (nothing to execute)", () => {
    expect(d([R, NOT])).toBe("הושלם");
    expect(d([R, NOT], [R, NOT], [R, NOT])).toBe("הושלם");
  });
  it("an approved subitem not yet בוצע prevents הושלם", () => {
    expect(d([A, NOT], [R, NOT])).toBe("טרם הוחל");
    expect(d([A, RUN])).toBe("בתהליך");
    expect(d([A, FAIL])).toBe("בתהליך");
    expect(d([A, DONE], [A, NOT])).toBe("בתהליך");
    expect(d([A, DONE], [A, FAIL], [R, NOT])).toBe("בתהליך");
    expect(d([A, DONE], [A, RUN])).toBe("בתהליך");
  });
  it("nothing executed yet (all approved still טרם בוצע) ⇒ טרם הוחל", () => {
    expect(d([A, NOT])).toBe("טרם הוחל");
    expect(d([A, NOT], [A, NOT], [R, NOT])).toBe("טרם הוחל");
    expect(d([A, ""])).toBe("טרם הוחל");
  });
  it("a rejected subitem's own sync value is irrelevant", () => {
    expect(d([A, DONE], [R, FAIL])).toBe("הושלם");
    expect(d([R, RUN])).toBe("הושלם");
  });
  it("matches an independent oracle for every combination of up to 4 subitems", () => {
    const decisions = [A, R, P];
    const syncs = [NOT, RUN, DONE, FAIL];
    const items: Array<[string, string]> = decisions.flatMap((x) => syncs.map((y) => [x, y] as [string, string]));
    let n = 0;
    const oracle = (cur: Array<[string, string]>) => {
      if (cur.length === 0) return "טרם הוחל";
      if (cur.some(([x]) => x === P)) return "בתהליך";
      const ap = cur.filter(([x]) => x === A);
      if (ap.every(([, y]) => y === DONE)) return "הושלם";
      return ap.every(([, y]) => y === NOT) ? "טרם הוחל" : "בתהליך";
    };
    const rec = (cur: Array<[string, string]>) => {
      expect(d(...cur)).toBe(oracle(cur));
      n++;
      if (cur.length < 3) for (const it of items) rec([...cur, it]);
    };
    rec([]);
    expect(n).toBe(1 + 12 + 144 + 1728);
  });
});

const parentWrites = (w: World) => w.fake.mutations.filter((m) => m.kind === "change" && m.args.boardId === PARENT_BOARD_ID);
const parentStatus = (w: World) => w.fake.col(PARENT, "color_mm9085gm");
const upd = (w: World, nv: string, decision = A) =>
  addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: nv, target: "400", decision });
const setDecision = (w: World, id: string, label: string) => (w.fake.items.get(id)!.columns.color_mm90s5mz!.text = label);

describe("parent status integration", () => {
  it("one approved executed + others still pending ⇒ בתהליך; completes when the rest are decided", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B", P);
    const c = upd(w, "C", P);
    expect((await w.exec.process(a)).status).toBe("applied");
    expect(parentStatus(w)).toBe("בתהליך");
    // reviewer rejects B → webhook enqueues a parent refresh job; C still pending
    setDecision(w, b, R);
    w.store.enqueue(b, PARENT, "parent");
    await w.worker.drain();
    expect(parentStatus(w)).toBe("בתהליך");
    // reviewer rejects the last pending one → parent completes
    setDecision(w, c, R);
    w.store.enqueue(c, PARENT, "parent");
    await w.worker.drain();
    expect(parentStatus(w)).toBe("הושלם");
  });

  it("all subitems rejected ⇒ הושלם (via the parent-refresh job)", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", R);
    const b = upd(w, "B", R);
    w.store.enqueue(b, PARENT, "parent");
    await w.worker.drain();
    expect(parentStatus(w)).toBe("הושלם");
    void a;
  });

  it("the parent shows בתהליך while a pending subitem exists, even before anything executes", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", P);
    upd(w, "B", P);
    setDecision(w, a, R);
    w.store.enqueue(a, PARENT, "parent");
    await w.worker.drain();
    expect(parentStatus(w)).toBe("בתהליך");
  });

  it("a failed execution keeps the parent בתהליך (not הושלם); the retry that succeeds completes it", async () => {
    const w = world();
    careerRecord(w);
    const bad = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "B", target: "999" });
    expect(await w.exec.process(bad)).toMatchObject({ status: "failed" });
    expect(w.fake.col(bad, "color_mm90k1tq")).toBe("נכשל");
    expect(parentStatus(w)).toBe("בתהליך");
    w.fake.add(BOARDS.career.id, "999", { alumni_id: "0123456789", company: "x" });
    expect((await w.exec.process(bad)).status).toBe("applied");
    expect(parentStatus(w)).toBe("הושלם");
  });

  it("approved ones done + the rest rejected (still טרם בוצע) ⇒ הושלם", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B");
    const r1 = upd(w, "R1", R);
    const r2 = upd(w, "R2", R);
    await w.exec.process(a);
    expect(parentStatus(w)).toBe("בתהליך"); // b approved but not executed yet, a done
    await w.exec.process(b);
    expect(parentStatus(w)).toBe("הושלם");
    expect(w.fake.col(r1, "color_mm90k1tq")).toBe("טרם בוצע");
    expect(w.fake.col(r2, "color_mm90k1tq")).toBe("טרם בוצע");
  });

  it("while an approved change is executing the parent shows בתהליך", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    let seen: string | null = null;
    w.fake.hooks.before = (_k, args) => {
      if (args.boardId === BOARDS.career.id) seen = parentStatus(w);
    };
    await w.exec.process(a);
    expect(seen).toBe("בתהליך");
    expect(parentStatus(w)).toBe("הושלם");
  });

  it("makes no parent mutation when the parent already has the right status", async () => {
    const w = world();
    careerRecord(w);
    upd(w, "A", P);
    upd(w, "B", P);
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בתהליך");
    const before = parentWrites(w).length;
    for (let i = 0; i < 3; i++) await syncParentOnce(w.fake, PARENT);
    expect(parentWrites(w)).toHaveLength(before);
    expect(before).toBe(1);
  });

  it("reads CURRENT decisions and sync statuses from monday, not the triggering event", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A", P);
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בתהליך");
    setDecision(w, a, A); // approved, not executed yet
    expect(await syncParentOnce(w.fake, PARENT)).toBe("טרם הוחל");
    w.fake.items.get(a)!.columns.color_mm90k1tq!.text = "בוצע"; // executed
    expect(await syncParentOnce(w.fake, PARENT)).toBe("הושלם");
    expect(parentStatus(w)).toBe("הושלם");
  });

  it("never writes the approval decision or the reviewer's request status", async () => {
    const w = world();
    careerRecord(w);
    await w.exec.process(upd(w, "A"));
    for (const m of w.fake.mutations) {
      if (m.kind !== "change") continue;
      expect(Object.keys(m.args.values)).not.toContain("color_mm90s5mz");
      if (m.args.boardId === PARENT_BOARD_ID) expect(Object.keys(m.args.values)).toEqual(["color_mm9085gm"]);
    }
    expect(w.fake.col(PARENT, "req_status")).toBe("ממתין לטיפול");
  });

  it("an API failure on the parent update does not lose the subitem result; the sweeper repairs it", async () => {
    const w = world();
    careerRecord(w);
    const s = upd(w, "A");
    let fail = true;
    w.fake.hooks.before = (_k, a) => {
      if (fail && a.boardId === PARENT_BOARD_ID) throw new MondayUncertainError("parent API down");
    };
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(w.fake.col(s, "color_mm90k1tq")).toBe("בוצע");
    expect(parentStatus(w)).toBe("טרם הוחל");
    expect(w.store.dirtyParents()).toEqual([PARENT]);
    fail = false;
    expect(await w.exec.sweepParents()).toBe(1);
    expect(parentStatus(w)).toBe("הושלם");
  });

  it("DRY_RUN performs no parent writes, including for decision-change jobs", async () => {
    const w = world({ dryRun: true });
    careerRecord(w);
    const a = upd(w, "A", R);
    w.store.enqueue(a, PARENT, "parent");
    await w.worker.drain();
    expect(w.fake.mutations).toHaveLength(0);
  });

  it("ignores parent-refresh jobs for missing or foreign items", async () => {
    const w = world();
    w.store.enqueue("123456", PARENT, "parent");
    await w.worker.drain();
    expect(w.fake.mutations).toHaveLength(0);
    expect(w.store.pendingJobCount()).toBe(0);
  });
});

describe("parent labels on the live board", () => {
  const setLabels = (w: World, labels: string[]) => {
    w.fake.schemas[PARENT_BOARD_ID]!.find((c) => c.id === "color_mm9085gm")!.labels = labels.map((label, i) => ({ id: i + 1, label }));
  };

  it("falls back to the older labels (מתבצע / בוצע) if that is what the column has", async () => {
    const w = world();
    setLabels(w, ["טרם הוחל", "מתבצע", "בוצע"]);
    careerRecord(w);
    const a = upd(w, "A", P);
    expect(await syncParentOnce(w.fake, PARENT)).toBe("מתבצע");
    setDecision(w, a, A);
    w.fake.items.get(a)!.columns.color_mm90k1tq!.text = "בוצע";
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בוצע");
  });

  it("a missing parent label never blocks applying a change; the parent stays dirty for retry", async () => {
    const w = world();
    setLabels(w, ["טרם הוחל"]);
    careerRecord(w);
    const s = upd(w, "A");
    expect((await w.exec.process(s)).status).toBe("applied");
    expect(w.fake.col("400", "company")).toBe("A");
    expect(w.fake.col(s, "color_mm90k1tq")).toBe("בוצע");
    expect(w.store.dirtyParents()).toEqual([PARENT]);
  });
});

describe("parent sync concurrency: an older calculation can never be the final write", () => {
  it("a refresh requested while another is calculating is recomputed afterwards (last request wins)", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B", P);
    w.fake.items.get(a)!.columns.color_mm90k1tq!.text = "בוצע"; // a is approved and already executed
    const sync = (w.exec as any).parents;
    const origList = w.fake.listSubitems.bind(w.fake);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.fake.listSubitems = async (pid) => {
      const snapshot = await origList(pid); // a approved, b pending ⇒ בתהליך
      if (++calls === 1) await gate;
      return snapshot;
    };
    const first = sync.refresh(PARENT);
    await new Promise((r) => setTimeout(r, 5));
    setDecision(w, b, R); // b is rejected meanwhile ⇒ הושלם
    await sync.refresh(PARENT);
    expect(parentStatus(w)).toBe("טרם הוחל");
    release();
    await first;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(parentStatus(w)).toBe("הושלם");
    expect(w.store.dirtyParents()).toEqual([]);
    void a;
  });

  it("concurrent executions of different subitems of one parent converge to the correct final status", async () => {
    const w = world();
    careerRecord(w);
    careerRecord(w, "401", { company: "Yep" });
    const a = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "A", target: "400" });
    const b = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Yep", newValue: "B", target: "401" });
    w.store.enqueue(a, PARENT);
    w.store.enqueue(b, PARENT);
    for (let i = 0; i < 4; i++) {
      await w.worker.drain();
      w.clock.t += 5000;
    }
    expect(w.fake.col("400", "company")).toBe("A");
    expect(w.fake.col("401", "company")).toBe("B");
    expect(parentStatus(w)).toBe("הושלם");
  });

  it("the parent lock is leased: a crashed holder cannot block updates forever", async () => {
    const w = world();
    careerRecord(w);
    const s = upd(w, "A");
    expect(w.store.tryLockParent(PARENT)).toBe(true); // holder "crashes" without unlocking
    await w.exec.process(s);
    expect(parentStatus(w)).toBe("טרם הוחל");
    w.clock.t += 60_000;
    expect(await w.exec.sweepParents()).toBe(1);
    expect(parentStatus(w)).toBe("הושלם");
  });
});
