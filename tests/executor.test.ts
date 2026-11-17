import { describe, expect, it } from "vitest";
import { BOARDS } from "../src/mapping/boards";
import { GRAD, NID, PARENT, addSub, careerRecord, world } from "./harness";

const run = (w: ReturnType<typeof world>, id: string) => w.exec.process(id);
const sync = (w: ReturnType<typeof world>, id: string) => w.fake.col(id, "color_mm90k1tq");

describe("update", () => {
  it("applies a single text update and marks the subitem done", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "job_title", existing: "מעצבת", newValue: "מנהלת עיצוב", target: "400" });
    const out = await run(w, s);
    expect(out.status).toBe("applied");
    expect(w.fake.col("400", "job_title")).toBe("מנהלת עיצוב");
    expect(sync(w, s)).toBe("בוצע");
    expect(w.fake.col(PARENT, "color_mm9085gm")).toBe("הושלם");
    expect(w.fake.col(PARENT, "req_status")).toBe("ממתין לטיפול"); // reviewer decision untouched
  });

  it.each([
    ["status", "mailing_consent", "לא", "כן", "alumni", "בוגרים", "3330"],
    ["phone", "mobile", "0501111111", "0522222222", "alumni", "בוגרים", GRAD],
    ["email", "email_main", "", "a@b.co", "alumni", "בוגרים", GRAD],
    ["checkbox", "no_work_declared", "false", "true", "alumni", "בוגרים", GRAD],
    ["date", "birth_date", "", "1990-05-01", "alumni", "בוגרים", GRAD],
    ["link", "linkedin", "", "https://linkedin.com/in/x", "alumni", "בוגרים", GRAD],
    ["country", "country", "", "ישראל", "alumni", "בוגרים", GRAD],
  ])("converts %s", async (_t, field, existing, nv, _k, label, target) => {
    const w = world();
    const t = target === "3330" ? GRAD : target;
    const s = addSub(w, { board: label, op: "עדכון", field, existing, newValue: nv, target: t });
    const out = await run(w, s);
    expect(out).toMatchObject({ status: "applied" });
    expect(w.fake.mutations.some((m) => m.kind === "change" && m.args.itemId === t && field in m.args.values)).toBe(true);
  });

  it("updates numbers and dropdowns on career", async () => {
    const w = world();
    careerRecord(w);
    const a = addSub(w, { board: "תעסוקה", op: "עדכון", field: "start_year", existing: "2020", newValue: "2021", target: "400" });
    expect((await run(w, a)).status).toBe("applied");
    expect(w.fake.col("400", "start_year")).toBe("2021");
  });

  it("applies grouped updates together in ONE mutation", async () => {
    const w = world();
    careerRecord(w, "400", {});
    w.fake.items.get("400")!.columns.cluster = { type: "dropdown", text: "עיצוב אמנות ותרבות", value: { ids: [2] } };
    w.fake.items.get("400")!.columns.domain = { type: "dropdown", text: "אחר", value: { ids: [2] } };
    const s = addSub(w, {
      board: "תעסוקה",
      op: "עדכון",
      field: "__grouped_update__",
      target: "400",
      newValue: JSON.stringify({ schemaVersion: 1, kind: "grouped_update", fields: { cluster: "טכנולוגיה והייטק", domain: "תוכנה" }, existingFields: { cluster: "עיצוב אמנות ותרבות", domain: "אחר" } }),
    });
    expect((await run(w, s)).status).toBe("applied");
    const muts = w.fake.targetMutations();
    expect(muts).toHaveLength(1);
    expect(Object.keys(muts[0]!.args.values).sort()).toEqual(["cluster", "domain"]);
  });

  it("grouped update does not require existingFields (historical only)", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "__grouped_update__", target: "400", newValue: JSON.stringify({ fields: { cluster: "טכנולוגיה והייטק", domain: "תוכנה" } }) });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.targetMutations()).toHaveLength(1);
  });

  it("grouped update still validates every field (one invalid value blocks all, nothing partially applied)", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "__grouped_update__", target: "400", newValue: JSON.stringify({ fields: { cluster: "טכנולוגיה והייטק", domain: "לא קיים" } }) });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "INVALID_VALUE_UNKNOWN_LABEL" });
    expect(w.fake.targetMutations()).toHaveLength(0);
  });
});

describe("create", () => {
  it("creates a career record owned by the graduate", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: JSON.stringify({ schemaVersion: 1, fields: { company: "Studio ABC", job_title: "מעצבת מוצר", role_status: "נוכחי", start_year: "2026", work_country: "ישראל" } }) });
    const out = await run(w, s);
    expect(out.status).toBe("applied");
    const created = w.fake.mutations.find((m) => m.kind === "create")!;
    expect(created.args.values.alumni_id).toBe(NID);
    expect(w.fake.col(s, "text_mm90g839")).toBe(created.args.id);
    expect(w.fake.col(created.args.id, "company")).toBe("Studio ABC");
  });

  it.each([
    ["education", "השכלה", { degree_type: "תואר שני", end_year: "2024" }],
    ["community", "תחומי עניין", { activity_type: "מרכז יזמות", interest_status: "מעוניין" }],
    ["referrals", "הפניות בוגרים", { ref_first: "שני", ref_last: "כהן", ref_phone: "054-555-5555" }],
  ])("creates on %s", async (key, label, fields) => {
    const w = world();
    const s = addSub(w, { board: label, op: "הוספה", field: "__new_record__", newValue: JSON.stringify({ schemaVersion: 1, fields }) });
    expect((await run(w, s)).status).toBe("applied");
    const c = w.fake.mutations.find((m) => m.kind === "create")!;
    expect(c.args.boardId).toBe((BOARDS as any)[key].id);
  });

  it("referral is created only after approval (not for pending/rejected)", async () => {
    const w = world();
    const s = addSub(w, { board: "הפניות בוגרים", op: "הוספה", field: "__new_record__", decision: "ממתין לאישור", newValue: JSON.stringify({ schemaVersion: 1, fields: { ref_first: "א" } }) });
    expect((await run(w, s)).status).toBe("ignored");
    expect(w.fake.mutations).toHaveLength(0);
  });

  it("rejects an owner id in the payload that differs from the parent's", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: JSON.stringify({ schemaVersion: 1, fields: { company: "X", alumni_id: "999" } }) });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "OWNERSHIP_MISMATCH" });
    expect(w.fake.targetMutations()).toHaveLength(0);
  });

  it("never creates on the Alumni board", async () => {
    const w = world();
    const s = addSub(w, { board: "בוגרים", op: "הוספה", field: "__new_record__", newValue: JSON.stringify({ schemaVersion: 1, fields: { first_name: "x" } }) });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "CREATE_NOT_ALLOWED" });
  });

  it("rejects unknown labels instead of creating labels", async () => {
    const w = world();
    const s = addSub(w, { board: "תעסוקה", op: "הוספה", field: "__new_record__", newValue: JSON.stringify({ schemaVersion: 1, fields: { company: "X", role_status: "לא קיים" } }) });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "INVALID_VALUE_UNKNOWN_LABEL" });
  });
});

describe("delete = archive", () => {
  it("archives exactly the verified record", async () => {
    const w = world();
    careerRecord(w);
    careerRecord(w, "401", { company: "Yep" });
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "400" });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.items.get("400")!.state).toBe("archived");
    expect(w.fake.items.get("401")!.state).toBe("active");
    expect(w.fake.mutations.filter((m) => m.kind === "archive")).toHaveLength(1);
  });

  it("refuses to archive the main Alumni record", async () => {
    const w = world();
    const s = addSub(w, { board: "בוגרים", op: "מחיקה", target: GRAD });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "ARCHIVE_NOT_ALLOWED" });
    expect(w.fake.items.get(GRAD)!.state).toBe("active");
  });

  it("refuses to archive a record owned by another graduate", async () => {
    const w = world();
    careerRecord(w, "400", { alumni_id: "555" });
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "400" });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "OWNERSHIP_MISMATCH" });
    expect(w.fake.items.get("400")!.state).toBe("active");
  });

  it("refuses when the target is on the wrong board", async () => {
    const w = world();
    w.fake.add(BOARDS.education.id, "500", { alumni_id: NID });
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "500" });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "TARGET_WRONG_BOARD" });
    expect(w.fake.items.get("500")!.state).toBe("active");
  });

  it("refuses referral archive and missing target id", async () => {
    const w = world();
    const a = addSub(w, { board: "הפניות בוגרים", op: "מחיקה", target: "1" });
    expect(await run(w, a)).toMatchObject({ code: "ARCHIVE_NOT_ALLOWED" });
    const b = addSub(w, { board: "תעסוקה", op: "מחיקה", target: null });
    expect(await run(w, b)).toMatchObject({ code: "TARGET_ID_MISSING" });
  });
});

describe("safety rules", () => {
  it("ignores subitems no longer approved", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400", decision: "נדחה" });
    expect((await run(w, s)).status).toBe("ignored");
    expect(w.fake.mutations).toHaveLength(0);
  });

  it("a changed current value is NOT a conflict: the approved change still applies (last executed wins)", async () => {
    const w = world();
    careerRecord(w, "400", { job_title: "שונה בינתיים" });
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "job_title", existing: "מעצבת", newValue: "מנהלת", target: "400" });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.col("400", "job_title")).toBe("מנהלת");
    expect(sync(w, s)).toBe("בוצע");
  });

  it("rejects non-writable / identity columns", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "alumni_id", existing: NID, newValue: "999", target: "400" });
    expect(await run(w, s)).toMatchObject({ code: "COLUMN_NOT_WRITABLE" });
    const s2 = addSub(w, { board: "בוגרים", op: "עדכון", field: "national_id", existing: NID, newValue: "999", target: GRAD });
    expect(await run(w, s2)).toMatchObject({ code: "COLUMN_NOT_WRITABLE" });
  });

  it("matches national ID exactly, preserving leading zeros", async () => {
    const w = world();
    // owner column holds the ID WITHOUT the leading zero → must not match the parent's "0123456789"
    careerRecord(w, "400", { alumni_id: NID.replace(/^0+/, "") });
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    expect(await run(w, s)).toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    expect(w.fake.col("400", "company")).toBe("Atera");
  });

  it("stops when the graduate is ambiguous (duplicate Alumni records)", async () => {
    const w = world();
    careerRecord(w);
    w.fake.add(BOARDS.alumni.id, "202", { national_id: NID });
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    expect(await run(w, s)).toMatchObject({ code: "GRADUATE_AMBIGUOUS" });
    expect(w.fake.targetMutations()).toHaveLength(0);
  });

  it("stops when the graduate does not exist", async () => {
    const w = world();
    w.fake.items.get(GRAD)!.state = "archived";
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    expect(await run(w, s)).toMatchObject({ code: "GRADUATE_NOT_FOUND" });
  });

  it("leaves unmatched-graduate requests for manual review without any writes", async () => {
    const w = world({ reqType: "בוגר שלא זוהה" });
    const s = addSub(w, { board: "בקשת זיהוי", op: "הוספה", field: "__new_record__", newValue: "{}" });
    expect(await run(w, s)).toMatchObject({ status: "manual_review", code: "UNMATCHED_GRADUATE" });
    expect(w.fake.mutations).toHaveLength(0);
  });

  it("rejects a change id that does not belong to the parent request", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400", changeId: "CHG-REQ-ZZZZ-001" });
    expect(await run(w, s)).toMatchObject({ code: "CHANGE_PARENT_ID_MISMATCH" });
  });

  it("fails closed on column type drift", async () => {
    const w = world();
    careerRecord(w);
    w.fake.schemas["5107220887"]!.find((c) => c.id === "job_title")!.type = "long_text";
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "job_title", existing: "מעצבת", newValue: "X", target: "400" });
    expect(await run(w, s)).toMatchObject({ code: "SCHEMA_DRIFT" });
  });

});
