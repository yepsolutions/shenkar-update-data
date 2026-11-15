import { describe, expect, it } from "vitest";
import { deriveApplicationStatus, syncParentOnce } from "../src/execution/parentStatus";
import { MondayUncertainError } from "../src/errors";
import { BOARDS, PARENT_BOARD_ID } from "../src/mapping/boards";
import { PARENT, addSub, careerRecord, world, type World } from "./harness";

const SYNC = ["טרם בוצע", "בתהליך", "בוצע", "נכשל"] as const;
const d = (...s: Array<[string, string]>) => deriveApplicationStatus(s.map(([decision, sync]) => ({ decision, sync })));
const A = "מאושר";

describe("deriveApplicationStatus", () => {
  it("rule 1: any נכשל ⇒ תקוע (even with pending / in-progress / done siblings)", () => {
    expect(d([A, "נכשל"])).toBe("תקוע");
    expect(d([A, "נכשל"], [A, "בתהליך"], [A, "בוצע"], [A, "טרם בוצע"])).toBe("תקוע");
  });
  it("rule 2: otherwise any בתהליך ⇒ מתבצע", () => {
    expect(d([A, "בתהליך"])).toBe("מתבצע");
    expect(d([A, "בתהליך"], [A, "בוצע"], [A, "טרם בוצע"])).toBe("מתבצע");
  });
  it("rule 3: בוצע only when ALL subitems are בוצע", () => {
    expect(d([A, "בוצע"])).toBe("בוצע");
    expect(d([A, "בוצע"], [A, "בוצע"], [A, "בוצע"])).toBe("בוצע");
    expect(d([A, "בוצע"], [A, "טרם בוצע"])).toBe("טרם הוחל");
  });
  it("rule 4: everything else (incl. any טרם בוצע) ⇒ טרם הוחל", () => {
    expect(d([A, "טרם בוצע"])).toBe("טרם הוחל");
    expect(d([A, "בוצע"], [A, "טרם בוצע"], [A, "בוצע"])).toBe("טרם הוחל");
    expect(d(["ממתין לאישור", "טרם בוצע"])).toBe("טרם הוחל");
    expect(d()).toBe("טרם הוחל");
    expect(d([A, ""])).toBe("טרם הוחל");
  });
  it("all subitems rejected ⇒ בוטל", () => {
    expect(d(["נדחה", "טרם בוצע"])).toBe("בוטל");
    expect(d(["נדחה", "טרם בוצע"], ["נדחה", "טרם בוצע"], ["נדחה", "טרם בוצע"])).toBe("בוטל");
  });
  it("approved all completed + the rest rejected ⇒ בוצע (partially approved)", () => {
    expect(d([A, "בוצע"], ["נדחה", "טרם בוצע"])).toBe("בוצע");
    expect(d([A, "בוצע"], [A, "בוצע"], ["נדחה", "טרם בוצע"], ["נדחה", "טרם בוצע"])).toBe("בוצע");
  });
  it("a subitem still pending approval prevents בוצע (and בוטל)", () => {
    expect(d([A, "בוצע"], ["ממתין לאישור", "טרם בוצע"])).toBe("טרם הוחל");
    expect(d([A, "בוצע"], ["ממתין לאישור", "טרם בוצע"], ["נדחה", "טרם בוצע"])).toBe("טרם הוחל");
    expect(d(["נדחה", "טרם בוצע"], ["ממתין לאישור", "טרם בוצע"])).toBe("טרם הוחל");
    expect(d(["ממתין לאישור", "טרם בוצע"])).toBe("טרם הוחל");
    // even a (data-inconsistent) pending-approval subitem marked בוצע must not complete the request
    expect(d([A, "בוצע"], ["ממתין לאישור", "בוצע"])).toBe("טרם הוחל");
  });
  it("priority is preserved: failure → תקוע, else in progress → מתבצע, else completion", () => {
    expect(d([A, "נכשל"], ["נדחה", "טרם בוצע"])).toBe("תקוע");
    expect(d([A, "נכשל"], [A, "בתהליך"], ["ממתין לאישור", "טרם בוצע"])).toBe("תקוע");
    expect(d([A, "בתהליך"], ["נדחה", "טרם בוצע"])).toBe("מתבצע");
    expect(d([A, "בתהליך"], ["ממתין לאישור", "טרם בוצע"], [A, "בוצע"])).toBe("מתבצע");
    expect(d([A, "טרם בוצע"], ["נדחה", "טרם בוצע"])).toBe("טרם הוחל");
  });
  it("a rejected subitem's own sync value is irrelevant", () => {
    expect(d([A, "בוצע"], ["נדחה", "נכשל"])).toBe("בוצע");
    expect(d(["נדחה", "בתהליך"])).toBe("בוטל");
  });
  it("matches an independent oracle for every combination of up to 4 subitems", () => {
    const oracle = (syncs: string[]) =>
      syncs.includes("נכשל") ? "תקוע" : syncs.includes("בתהליך") ? "מתבצע" : syncs.length && syncs.every((x) => x === "בוצע") ? "בוצע" : "טרם הוחל";
    let n = 0;
    const rec = (cur: string[]) => {
      expect(d(...cur.map((x) => [A, x] as [string, string]))).toBe(oracle(cur));
      n++;
      if (cur.length < 4) for (const x of SYNC) rec([...cur, x]);
    };
    rec([]);
    expect(n).toBe(1 + 4 + 16 + 64 + 256);
  });
  it("uses only existing parent-board labels", () => {
    const labels = new Set(["מתבצע", "בוצע", "תקוע", "בוטל", "טרם הוחל"]);
    for (const x of SYNC) for (const y of SYNC) expect(labels.has(d([A, x], [A, y]))).toBe(true);
  });
});

const parentWrites = (w: World) => w.fake.mutations.filter((m) => m.kind === "change" && m.args.boardId === PARENT_BOARD_ID);
const parentStatus = (w: World) => w.fake.col(PARENT, "color_mm9085gm");
const upd = (w: World, nv: string, target = "400", field = "company", existing = "Atera") =>
  addSub(w, { board: "תעסוקה", op: "עדכון", field, existing, newValue: nv, target });

describe("parent sync after executions", () => {
  it("multiple subitems: stays טרם הוחל until ALL are done, then בוצע", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B");
    const c = upd(w, "C");
    await w.exec.process(a);
    expect(parentStatus(w)).toBe("טרם הוחל");
    await w.exec.process(b);
    expect(parentStatus(w)).toBe("טרם הוחל");
    await w.exec.process(c);
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("shows מתבצע while a subitem is בתהליך (recalculated right after the status change)", async () => {
    const w = world();
    careerRecord(w);
    const s = upd(w, "A");
    let seen: string | null = null;
    w.fake.hooks.before = (_k, a) => {
      if (a.boardId === BOARDS.career.id) seen = parentStatus(w);
    };
    await w.exec.process(s);
    expect(seen).toBe("מתבצע");
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("a failure ⇒ תקוע; a successful retry recalculates to בוצע", async () => {
    const w = world();
    careerRecord(w);
    const ok = upd(w, "A");
    const bad = upd(w, "B", "400", "role_status", "נוכחי");
    w.fake.items.get(bad)!.columns.text_mm94nbav!.text = JSON.stringify({ schemaVersion: 1, operation: "update", fieldColumnId: "role_status", newValue: "אין-כזה" });
    await w.exec.process(ok);
    expect(await w.exec.process(bad)).toMatchObject({ status: "failed" });
    expect(w.fake.col(bad, "color_mm90k1tq")).toBe("נכשל");
    expect(parentStatus(w)).toBe("תקוע");
    // reviewer fixes the data and re-approves → retry succeeds
    w.fake.items.get(bad)!.columns.text_mm94nbav!.text = JSON.stringify({ schemaVersion: 1, operation: "update", fieldColumnId: "role_status", newValue: "עבר" });
    expect((await w.exec.process(bad)).status).toBe("applied");
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("mixed: one done + one failed + one pending ⇒ תקוע", async () => {
    const w = world();
    careerRecord(w);
    const ok = upd(w, "A");
    const bad = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "B", target: "999" }); // target missing
    addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "C", target: "400", decision: "ממתין לאישור" });
    await w.exec.process(ok);
    await w.exec.process(bad);
    expect(parentStatus(w)).toBe("תקוע");
  });

  it("a rejected sibling does not block בוצע", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "R", target: "400", decision: "נדחה" });
    await w.exec.process(a);
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("all subitems rejected ⇒ בוטל (written once, no further mutation)", async () => {
    const w = world();
    careerRecord(w);
    addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "A", target: "400", decision: "נדחה" });
    addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "B", target: "400", decision: "נדחה" });
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בוטל");
    expect(parentStatus(w)).toBe("בוטל");
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בוטל");
    expect(parentWrites(w)).toHaveLength(1);
    expect(w.fake.col(PARENT, "req_status")).toBe("ממתין לטיפול");
    expect(w.fake.mutations.some((m) => m.kind === "change" && "color_mm90s5mz" in m.args.values)).toBe(false);
  });

  it("partially approved: approved ones done + the rest rejected ⇒ בוצע", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B");
    addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "R", target: "400", decision: "נדחה" });
    await w.exec.process(a);
    expect(parentStatus(w)).toBe("טרם הוחל"); // b approved but not yet executed
    await w.exec.process(b);
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("pending-approval subitem prevents בוצע until it is decided", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const pending = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "P", target: "400", decision: "ממתין לאישור" });
    addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "x", newValue: "R", target: "400", decision: "נדחה" });
    await w.exec.process(a);
    expect(parentStatus(w)).toBe("טרם הוחל");
    // reviewer rejects the pending one → parent can now complete on the next recalculation
    w.fake.items.get(pending)!.columns.color_mm90s5mz!.text = "נדחה";
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בוצע");
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("reads CURRENT monday statuses, not the triggering event", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B");
    await w.exec.process(a);
    expect(parentStatus(w)).toBe("טרם הוחל");
    // someone completes B outside this backend; the next recalculation sees it
    w.fake.items.get(b)!.columns.color_mm90k1tq!.text = "בוצע";
    expect(await syncParentOnce(w.fake, PARENT)).toBe("בוצע");
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("makes no parent mutation when the parent already has the right status", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B");
    await w.exec.process(a); // טרם הוחל → מתבצע → טרם הוחל? (writes while running/finished)
    const before = parentWrites(w).length;
    for (let i = 0; i < 3; i++) expect(await syncParentOnce(w.fake, PARENT)).toBe("טרם הוחל");
    expect(parentWrites(w)).toHaveLength(before);
    void b;
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
    const out = await w.exec.process(s);
    expect(out.status).toBe("applied");
    expect(w.fake.col(s, "color_mm90k1tq")).toBe("בוצע");
    expect(w.store.get(w.fake.col(s, "text_mm90t835")!)!.state).toBe("applied");
    expect(parentStatus(w)).toBe("טרם הוחל"); // stale for now
    expect(w.store.dirtyParents()).toEqual([PARENT]);
    fail = false;
    expect(await w.exec.sweepParents()).toBe(1);
    expect(parentStatus(w)).toBe("בוצע");
    expect(w.store.dirtyParents()).toEqual([]);
  });

  it("a duplicate webhook of a completed change causes no further parent mutation", async () => {
    const w = world();
    careerRecord(w);
    const s = upd(w, "A");
    await w.exec.process(s);
    const n = w.fake.mutations.length;
    await w.exec.process(s);
    expect(w.fake.mutations).toHaveLength(n);
  });

  it("DRY_RUN performs no parent (or any) writes", async () => {
    const w = world({ dryRun: true });
    careerRecord(w);
    const s = upd(w, "A");
    expect((await w.exec.process(s)).status).toBe("dry_run");
    expect(w.fake.mutations).toHaveLength(0);
    expect(await w.exec.sweepParents()).toBe(0);
  });
});

describe("parent sync concurrency: an older calculation can never be the final write", () => {
  it("a refresh requested while another is calculating is recomputed afterwards (last request wins)", async () => {
    const w = world();
    careerRecord(w);
    const a = upd(w, "A");
    const b = upd(w, "B");
    w.fake.items.get(a)!.columns.color_mm90k1tq!.text = "בוצע";
    w.fake.items.get(b)!.columns.color_mm90k1tq!.text = "טרם בוצע";
    // 1st calculation reads (a=בוצע, b=טרם בוצע), then stalls before writing; meanwhile b completes and a 2nd refresh arrives
    const sync = (w.exec as any).parents;
    const origList = w.fake.listSubitems.bind(w.fake);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.fake.listSubitems = async (pid) => {
      const snapshot = await origList(pid);
      if (++calls === 1) await gate; // stale snapshot is held back
      return snapshot;
    };
    const first = sync.refresh(PARENT);
    await new Promise((r) => setTimeout(r, 5));
    w.fake.items.get(b)!.columns.color_mm90k1tq!.text = "בוצע";
    await sync.refresh(PARENT); // returns immediately: the holder will pick the request up
    expect(parentStatus(w)).toBe("טרם הוחל");
    release();
    await first;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(parentStatus(w)).toBe("בוצע"); // not overwritten by the stale snapshot
    expect(w.store.dirtyParents()).toEqual([]);
  });

  it("concurrent executions of different subitems of one parent converge to the correct final status", async () => {
    const w = world();
    careerRecord(w);
    careerRecord(w, "401", { company: "Yep" });
    const a = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "A", target: "400" });
    const b = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Yep", newValue: "B", target: "401" });
    // same graduate+board ⇒ the lock defers one; run via the worker until both finish
    w.store.enqueue(a, PARENT);
    w.store.enqueue(b, PARENT);
    for (let i = 0; i < 4; i++) {
      await w.worker.drain();
      w.clock.t += 5000;
    }
    expect(w.fake.col("400", "company")).toBe("A");
    expect(w.fake.col("401", "company")).toBe("B");
    expect(parentStatus(w)).toBe("בוצע");
  });

  it("the parent lock is leased: a crashed holder cannot block updates forever", async () => {
    const w = world();
    careerRecord(w);
    const s = upd(w, "A");
    expect(w.store.tryLockParent(PARENT)).toBe(true); // holder "crashes" without unlocking
    await w.exec.process(s);
    expect(w.store.dirtyParents()).toEqual([]); // dirty but locked → not listed yet
    expect(parentStatus(w)).toBe("טרם הוחל");
    w.clock.t += 60_000; // lease expires
    expect(await w.exec.sweepParents()).toBe(1);
    expect(parentStatus(w)).toBe("בוצע");
  });
});
