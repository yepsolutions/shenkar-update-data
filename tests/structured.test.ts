import { describe, expect, it } from "vitest";
import { BOARDS } from "../src/mapping/boards";
import { GRAD, NID, addSub, careerRecord, world } from "./harness";

const run = (w: ReturnType<typeof world>, id: string) => w.exec.process(id);
const J = (o: Record<string, unknown>) => ({ schemaVersion: 1, ...o });

describe("technical columns are authoritative", () => {
  it("reads text_mm94m751 + text_mm94nbav and ignores misleading Hebrew display columns", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, {
      board: "תעסוקה", op: "עדכון", field: "job_title", existing: "מעצבת", newValue: "מנהלת עיצוב", target: "400",
      display: { field: "שם חברה", existing: "Atera", newValue: "SHOULD NOT BE USED" },
    });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.col("400", "job_title")).toBe("מנהלת עיצוב");
    expect(w.fake.col("400", "company")).toBe("Atera");
  });

  it.each([
    ["technical id missing", { tech: null, json: J({ operation: "update", fieldColumnId: "company", existingValue: "", newValue: "x" }) }],
    ["json missing", { tech: "company", json: null }],
    ["json blank", { tech: "company", json: "   " }],
  ])("fails safely (no fallback to display columns) when %s", async (_n, tj) => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", target: "400", ...tj, display: { field: "company", existing: "Atera", newValue: "X" } });
    expect(await run(w, s)).toMatchObject({ status: "failed", code: "TECHNICAL_DATA_MISSING" });
    expect(w.fake.targetMutations()).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "company", "{not json", "INVALID_PAYLOAD_JSON"],
    ["schemaVersion 2", "company", { schemaVersion: 2, operation: "update", fieldColumnId: "company", existingValue: "Atera", newValue: "x" }, "INVALID_PAYLOAD"],
    ["missing newValue", "company", J({ operation: "update", fieldColumnId: "company", existingValue: "Atera" }), "INVALID_PAYLOAD"],
    ["object as value", "company", J({ operation: "update", fieldColumnId: "company", existingValue: "Atera", newValue: { a: 1 } }), "INVALID_PAYLOAD"],
    ["fieldColumnId ≠ technical id", "job_title", J({ operation: "update", fieldColumnId: "company", existingValue: "Atera", newValue: "x" }), "FIELD_ID_MISMATCH"],
    ["wrong operation", "company", J({ operation: "create", fieldColumnId: "company", existingValue: "Atera", newValue: "x" }), "INVALID_PAYLOAD"],
    ["unknown __marker__", "__drop_table__", J({ operation: "update" }), "INVALID_TECHNICAL_ID"],
    ["invalid column id", "Company Name!", J({ operation: "update", fieldColumnId: "Company Name!", existingValue: "", newValue: "" }), "INVALID_TECHNICAL_ID"],
    ["create without fields", "__new_record__", J({ operation: "create" }), "INVALID_PAYLOAD"],
  ])("rejects %s", async (_n, tech, json, code) => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: tech === "__new_record__" ? "הוספה" : "עדכון", target: tech === "__new_record__" ? null : "400", tech, json });
    expect(await run(w, s)).toMatchObject({ status: "failed", code });
    expect(w.fake.targetMutations()).toHaveLength(0);
  });

  it("requires the operation label to agree with the JSON operation", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "400", tech: "company", json: J({ operation: "update", fieldColumnId: "company", existingValue: "Atera", newValue: "x" }) });
    expect(await run(w, s)).toMatchObject({ code: "OPERATION_MISMATCH" });
    expect(w.fake.items.get("400")!.state).toBe("active");
  });

  it("fails when the technical columns do not exist on the board (schema drift)", async () => {
    const w = world();
    careerRecord(w);
    w.fake.schemas["5107603016"] = w.fake.schemas["5107603016"]!.filter((c) => c.id !== "text_mm94nbav");
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", field: "company", existing: "Atera", newValue: "X", target: "400" });
    expect(await run(w, s)).toMatchObject({ code: "SCHEMA_DRIFT" });
  });
});

describe("structured operations", () => {
  it("single update: portal booleans map to the status labels through the central alias map", async () => {
    const w = world();
    const s = addSub(w, { board: "בוגרים", op: "עדכון", target: GRAD, tech: "mailing_consent", json: J({ operation: "update", fieldColumnId: "mailing_consent", existingValue: "false", newValue: "true" }) });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.col(GRAD, "mailing_consent")).toBe("כן");
  });

  it("mailing_consent mapping: true/\"true\" → כן and false/\"false\" → לא (booleans and strings)", async () => {
    for (const [nv, label] of [[true, "כן"], ["true", "כן"], [false, "לא"], ["false", "לא"]] as const) {
      const w = world();
      w.fake.items.get(GRAD)!.columns.mailing_consent!.text = label === "כן" ? "לא" : "כן";
      const s = addSub(w, { board: "בוגרים", op: "עדכון", target: GRAD, tech: "mailing_consent", json: J({ operation: "update", fieldColumnId: "mailing_consent", existingValue: "x", newValue: nv }) });
      expect((await run(w, s)).status).toBe("applied");
      expect(w.fake.col(GRAD, "mailing_consent")).toBe(label);
    }
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["blank", "  "],
    ["unknown", "maybe"],
    ["uppercase TRUE (only exact true/false are mapped)", "TRUE"],
    ["padded", " true"],
    ["number 1", 1],
    ["yes", "yes"],
    ["undefined key", undefined],
  ])("mailing_consent rejects unsupported value: %s", async (_n, nv) => {
    const w = world();
    const json = nv === undefined ? J({ operation: "update", fieldColumnId: "mailing_consent" }) : J({ operation: "update", fieldColumnId: "mailing_consent", newValue: nv });
    const s = addSub(w, { board: "בוגרים", op: "עדכון", target: GRAD, tech: "mailing_consent", json });
    const out = await run(w, s);
    expect(out.status).toBe("failed");
    expect(w.fake.col(GRAD, "mailing_consent")).toBe("לא");
    expect(w.fake.targetMutations()).toHaveLength(0);
  });

  it("there is no generic boolean→status conversion: other status columns reject booleans", async () => {
    const w = world();
    const s = addSub(w, { board: "בוגרים", op: "עדכון", target: GRAD, tech: "wants_contact", json: J({ operation: "update", fieldColumnId: "wants_contact", newValue: true }) });
    expect((await run(w, s)).status).toBe("failed");
    const w2 = world();
    w2.fake.schemas["5107220873"]!.find((c) => c.id === "degree_type")!.labels!.push({ id: 9, label: "כן" });
    w2.fake.add(BOARDS.education.id, "800", { alumni_id: NID, degree_type: "תואר ראשון" });
    const s2 = addSub(w2, { board: "השכלה", op: "עדכון", target: "800", tech: "degree_type", json: J({ operation: "update", fieldColumnId: "degree_type", newValue: true }) });
    expect((await run(w2, s2)).status).toBe("failed"); // "true" is not mapped for degree_type
  });

  it("ongoing keeps its explicit yes/no mapping", async () => {
    const w = world();
    w.fake.add(BOARDS.education.id, "800", { alumni_id: NID, ongoing: "לא" });
    const s = addSub(w, { board: "השכלה", op: "עדכון", target: "800", tech: "ongoing", json: J({ operation: "update", fieldColumnId: "ongoing", newValue: true }) });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.col("800", "ongoing")).toBe("כן");
  });

  it("new record: JSON numbers are accepted; the owner is the verified graduate", async () => {
    const w = world();
    const s = addSub(w, {
      board: "השכלה", op: "הוספה",
      tech: "__new_record__",
      json: J({ operation: "create", fields: { institution: "שנקר. הנדסה. עיצוב. אמנות", degree_type: "תואר ראשון", end_year: 2025 } }),
    });
    expect((await run(w, s)).status).toBe("applied");
    const c = w.fake.mutations.find((m) => m.kind === "create")!;
    expect(c.args.boardId).toBe(BOARDS.education.id);
    expect(c.args.values.alumni_id).toBe(NID);
    expect(c.args.values.end_year).toBe("2025");
  });

  it("grouped update applied atomically (existingFields optional, historical only)", async () => {
    const w = world();
    careerRecord(w);
    w.fake.items.get("400")!.columns.cluster = { type: "dropdown", text: "עיצוב אמנות ותרבות", value: { ids: [2] } };
    w.fake.items.get("400")!.columns.domain = { type: "dropdown", text: "אחר", value: { ids: [2] } };
    const s = addSub(w, { board: "תעסוקה", op: "עדכון", target: "400", tech: "__grouped_update__", json: J({ operation: "update", existingFields: { cluster: "עיצוב אמנות ותרבות", domain: "אחר" }, fields: { cluster: "טכנולוגיה והייטק", domain: "תוכנה" } }) });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.targetMutations()).toHaveLength(1);
  });
});

describe("deletion via __delete_record__ (archive only)", () => {
  it("archives the verified target taken from the JSON targetRecordId", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: "400" }) });
    expect((await run(w, s)).status).toBe("applied");
    expect(w.fake.items.get("400")!.state).toBe("archived");
  });

  it("refuses when JSON target and target-record column disagree (never guesses)", async () => {
    const w = world();
    careerRecord(w);
    careerRecord(w, "401");
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", target: "401", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: "400" }) });
    expect(await run(w, s)).toMatchObject({ code: "TARGET_ID_MISMATCH" });
    expect(w.fake.items.get("400")!.state).toBe("active");
    expect(w.fake.items.get("401")!.state).toBe("active");
  });

  it("refuses without any explicit target id", async () => {
    const w = world();
    careerRecord(w);
    const s = addSub(w, { board: "תעסוקה", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete" }) });
    expect(await run(w, s)).toMatchObject({ code: "TARGET_ID_MISSING" });
  });

  it("never archives the main Alumni item, nor a record of another graduate, nor on the wrong board", async () => {
    const w = world();
    const a = addSub(w, { board: "בוגרים", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: GRAD }) });
    expect(await run(w, a)).toMatchObject({ code: "ARCHIVE_NOT_ALLOWED" });
    careerRecord(w, "400", { alumni_id: "555" });
    const b = addSub(w, { board: "תעסוקה", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: "400" }) });
    expect(await run(w, b)).toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    w.fake.add(BOARDS.education.id, "500", { alumni_id: NID });
    const c = addSub(w, { board: "תעסוקה", op: "מחיקה", tech: "__delete_record__", json: J({ operation: "delete", targetRecordId: "500" }) });
    expect(await run(w, c)).toMatchObject({ code: "TARGET_WRONG_BOARD" });
    expect(w.fake.mutations.filter((m) => m.kind === "archive")).toHaveLength(0);
    expect(w.fake.items.get(GRAD)!.state).toBe("active");
  });
});
