import { Executor } from "../src/execution/executor";
import { Worker } from "../src/execution/worker";
import { silentLogger } from "../src/logger";
import { BOARDS, PARENT_BOARD_ID, SUBITEM_BOARD_ID } from "../src/mapping/boards";
import { SchemaGuard } from "../src/monday/schema";
import { Store } from "../src/store/store";
import { FakeMonday } from "./fakeMonday";

export const NID = "0123456789"; // leading zero must survive
export const PARENT = "100";
export const GRAD = "200";

export interface World {
  fake: FakeMonday;
  store: Store;
  exec: Executor;
  worker: Worker;
  clock: { t: number };
}

export function world(opts: { reqType?: string } = {}): World {
  const fake = new FakeMonday();
  const clock = { t: 1_000_000 };
  const store = new Store(":memory:", () => clock.t, 60_000, 5);
  const exec = new Executor({
    api: fake,
    store,
    schema: new SchemaGuard(fake, 600_000, () => clock.t),
    log: silentLogger,
    convert: { phoneCountry: "IL" },
  });
  const worker = new Worker(store, exec, silentLogger, 1000, 3);
  fake.add(PARENT_BOARD_ID, PARENT, {
    req_type: opts.reqType ?? "עדכון בוגר קיים",
    alumni_id: NID,
    alumni_name: "דנה לוי",
    ext_req_id: "REQ-AB12CD34",
    req_status: "ממתין לטיפול",
    color_mm9085gm: "טרם הוחל",
  });
  fake.add(BOARDS.alumni.id, GRAD, { national_id: NID, first_name: "דנה", mobile: "0501111111", mailing_consent: "לא" });
  // a different graduate whose ID is a loose match (without the leading zero) — must never be confused
  fake.add(BOARDS.alumni.id, "201", { national_id: NID.replace(/^0+/, ""), first_name: "אחר" });
  return { fake, store, exec, worker, clock };
}

let seq = 0;
export interface SubSpec {
  id?: string;
  board: string; // label
  op: "עדכון" | "הוספה" | "מחיקה";
  /** Convenience: builds the technical columns (text_mm94m751 / text_mm94nbav). */
  field?: string;
  existing?: string | null;
  newValue?: string | null;
  target?: string | null;
  /** Explicit technical columns (override the convenience builder). */
  tech?: string | null;
  json?: unknown; // object → JSON.stringify; string → written verbatim
  decision?: string;
  sync?: string;
  changeId?: string;
  /** Hebrew display columns; the backend must never read them. */
  display?: { field?: string; existing?: string; newValue?: string };
}

function technical(s: SubSpec): { tech: string | null; json: string | null } {
  if (s.tech !== undefined || s.json !== undefined) {
    return {
      tech: s.tech ?? null,
      json: s.json === undefined || s.json === null ? null : typeof s.json === "string" ? s.json : JSON.stringify(s.json),
    };
  }
  if (s.field === "__new_record__") {
    const fields = JSON.parse(s.newValue ?? "{}").fields;
    return { tech: s.field, json: JSON.stringify({ schemaVersion: 1, operation: "create", fields }) };
  }
  if (s.field === "__grouped_update__") {
    const p = JSON.parse(s.newValue ?? "{}");
    return { tech: s.field, json: JSON.stringify({ schemaVersion: 1, operation: "update", fields: p.fields, existingFields: p.existingFields }) };
  }
  if (s.op === "מחיקה") {
    return { tech: "__delete_record__", json: JSON.stringify({ schemaVersion: 1, operation: "delete", ...(s.target ? { targetRecordId: s.target } : {}) }) };
  }
  return {
    tech: s.field ?? null,
    json: JSON.stringify({ schemaVersion: 1, operation: "update", fieldColumnId: s.field, existingValue: s.existing ?? "", newValue: s.newValue ?? "" }),
  };
}

export function addSub(w: World, s: SubSpec): string {
  seq++;
  const id = s.id ?? String(300 + seq);
  const t = technical(s);
  w.fake.add(
    SUBITEM_BOARD_ID,
    id,
    {
      color_mm90s5mz: s.decision ?? "מאושר",
      status: s.board,
      color_mm90ba0r: s.op,
      text_mm94m751: t.tech,
      text_mm94nbav: t.json,
      // human-readable display columns: deliberately misleading so any fallback read would be caught
      text_mm90znvp: s.display?.field ?? "שדה בעברית",
      text_mm901sz0: s.display?.existing ?? "ערך ישן",
      text_mm909hnw: s.display?.newValue ?? "ערך חדש",
      text_mm90t835: s.changeId ?? `CHG-REQ-AB12CD34-${String(seq).padStart(3, "0")}`,
      color_mm90k1tq: s.sync ?? "טרם בוצע",
      text_mm90g839: s.target ?? null,
    },
    { parentId: PARENT },
  );
  return id;
}

export const careerRecord = (w: World, id = "400", over: Record<string, string> = {}) =>
  w.fake.add(BOARDS.career.id, id, { alumni_id: NID, company: "Atera", job_title: "מעצבת", start_year: "2020", ...over });
