import type { ColumnDef, ItemColumn, MItem, MondayApi } from "../src/domain";
import { MondayRejectedError, MondayUncertainError } from "../src/errors";
import { BOARDS, PARENT_BOARD_ID, SUBITEM_BOARD_ID } from "../src/mapping/boards";

const L = (labels: string[]) => labels.map((label, i) => ({ id: i + 1, label }));

export const SCHEMAS: Record<string, ColumnDef[]> = {
  [PARENT_BOARD_ID]: [
    { id: "req_type", type: "status", labels: L(["עדכון בוגר קיים", "בוגר שלא זוהה"]) },
    { id: "alumni_id", type: "text" },
    { id: "alumni_name", type: "text" },
    { id: "ext_req_id", type: "text" },
    { id: "req_status", type: "status", labels: L(["ממתין לטיפול", "אושר במלואו"]) },
    { id: "color_mm9085gm", type: "status", labels: L(["מתבצע", "בוצע", "תקוע", "בוטל", "טרם הוחל"]) },
  ],
  [SUBITEM_BOARD_ID]: [
    { id: "color_mm90s5mz", type: "status", labels: L(["מאושר", "נדחה", "ממתין לאישור"]) },
    { id: "status", type: "status", labels: L(["השכלה", "תעסוקה", "בוגרים", "תחומי עניין", "הפניות בוגרים"]) },
    { id: "color_mm90ba0r", type: "status", labels: L(["עדכון", "הוספה", "מחיקה"]) },
    { id: "text_mm90znvp", type: "text" },
    { id: "text_mm901sz0", type: "text" },
    { id: "text_mm909hnw", type: "text" },
    { id: "text_mm94m751", type: "text" },
    { id: "text_mm94nbav", type: "text" },
    { id: "text_mm90t835", type: "text" },
    { id: "color_mm90k1tq", type: "status", labels: L(["בתהליך", "בוצע", "נכשל", "טרם בוצע"]) },
    { id: "text_mm90g839", type: "text" },
  ],
  [BOARDS.alumni.id]: [
    { id: "national_id", type: "text" },
    { id: "first_name", type: "text" },
    { id: "mobile", type: "phone" },
    { id: "email_main", type: "email" },
    { id: "country", type: "country" },
    { id: "mailing_consent", type: "status", labels: L(["כן", "לא", "לא ידוע"]) },
    { id: "no_work_declared", type: "checkbox" },
    { id: "birth_date", type: "date" },
    { id: "linkedin", type: "link" },
  ],
  [BOARDS.education.id]: [
    { id: "alumni_id", type: "text" },
    { id: "degree_type", type: "status", labels: L(["תואר ראשון", "תואר שני"]) },
    { id: "end_year", type: "numbers" },
    { id: "ongoing", type: "status", labels: L(["כן", "לא"]) },
    { id: "institution", type: "dropdown", labels: L(["שנקר. הנדסה. עיצוב. אמנות", "אוניברסיטת תל אביב"]) },
  ],
  [BOARDS.career.id]: [
    { id: "alumni_id", type: "text" },
    { id: "company", type: "text" },
    { id: "job_title", type: "text" },
    { id: "role_status", type: "status", labels: L(["נוכחי", "עבר"]) },
    { id: "start_year", type: "numbers" },
    { id: "work_country", type: "country" },
    { id: "cluster", type: "dropdown", labels: L(["טכנולוגיה והייטק", "עיצוב אמנות ותרבות"]) },
    { id: "domain", type: "dropdown", labels: L(["תוכנה", "אחר"]) },
  ],
  [BOARDS.referrals.id]: [
    { id: "referrer_id", type: "text" },
    { id: "ref_first", type: "text" },
    { id: "ref_last", type: "text" },
    { id: "ref_phone", type: "phone" },
  ],
  [BOARDS.community.id]: [
    { id: "alumni_id", type: "text" },
    { id: "activity_type", type: "dropdown", labels: L(["השתתפות באירועי תוכן", "מרכז יזמות"]) },
    { id: "interest_status", type: "status", labels: L(["מעוניין", "לא מעוניין"]) },
  ],
};

export interface Hooks {
  /** Called before a mutation is applied; may throw to simulate a refusal. */
  before?: (kind: string, args: any) => void;
  /** Called after a mutation was applied; may throw to simulate a lost response / crash. */
  after?: (kind: string, args: any) => void;
}

/** In-memory monday: applies mutations to column values so reads reflect them. */
export class FakeMonday implements MondayApi {
  items = new Map<string, MItem>();
  nextId = 9000;
  mutations: Array<{ kind: string; args: any }> = [];
  hooks: Hooks = {};
  schemas = structuredClone(SCHEMAS);

  private colDef(boardId: string, col: string) {
    return this.schemas[boardId]?.find((c) => c.id === col);
  }

  add(boardId: string, id: string, cols: Record<string, string | null | { text: string; value: any }>, extra: Partial<MItem> = {}): MItem {
    const columns: Record<string, ItemColumn> = {};
    for (const [k, v] of Object.entries(cols)) {
      const def = this.colDef(boardId, k);
      if (typeof v === "object" && v !== null) columns[k] = { type: def?.type ?? "text", text: v.text, value: v.value };
      else columns[k] = { type: def?.type ?? "text", text: v, value: null };
    }
    const item: MItem = { id, name: "item", state: "active", boardId, columns, createdAt: "2026-01-01T00:00:00Z", ...extra };
    this.items.set(id, item);
    return item;
  }

  async getItem(id: string) {
    const i = this.items.get(id);
    return i ? structuredClone(i) : null;
  }
  async getBoardColumns(boardId: string) {
    return structuredClone(this.schemas[boardId] ?? []);
  }
  async findItemsByColumn(boardId: string, columnId: string, value: string) {
    // monday matching is loose; emulate by returning trimmed/numeric-equal matches so callers must re-check.
    return [...this.items.values()]
      .filter((i) => i.boardId === boardId && i.state === "active" && (i.columns[columnId]?.text ?? "").includes(value.replace(/^0+/, "")))
      .map((i) => structuredClone(i));
  }
  async listSubitems(parentId: string) {
    return [...this.items.values()].filter((i) => i.parentId === parentId).map((i) => structuredClone(i));
  }

  private applyValue(boardId: string, item: MItem, col: string, v: any) {
    const def = this.colDef(boardId, col);
    if (!def) throw new MondayRejectedError("InvalidColumnIdException");
    let text: string | null = null;
    let value: any = null;
    if (v === null) {
      /* cleared */
    } else if (typeof v === "string") text = v;
    else if (def.type === "status") {
      const l = def.labels?.find((x) => x.label === v.label);
      if (!l) throw new MondayRejectedError("ColumnValueException");
      text = l.label;
      value = { index: l.id };
    } else if (def.type === "dropdown") {
      const ids = (v.labels as string[]).map((n) => {
        const l = def.labels?.find((x) => x.label === n);
        if (!l) throw new MondayRejectedError("ColumnValueException");
        return l.id;
      });
      text = v.labels.join(", ");
      value = { ids };
    } else if (def.type === "phone") {
      text = v.phone;
      value = { phone: v.phone, countryShortName: v.countryShortName };
    } else if (def.type === "email") {
      text = v.email;
      value = v;
    } else if (def.type === "link") {
      text = v.url;
      value = v;
    } else if (def.type === "date") {
      text = v.date;
      value = v;
    } else if (def.type === "checkbox") {
      text = v.checked === "true" ? "v" : "";
      value = { checked: v.checked };
    } else if (def.type === "country") {
      text = v.countryName;
      value = v;
    } else if (def.type === "long_text") {
      text = v.text;
      value = v;
    }
    item.columns[col] = { type: def.type, text, value };
  }

  async changeColumns(boardId: string, itemId: string, values: Record<string, unknown>) {
    const args = { boardId, itemId, values };
    this.hooks.before?.("change", args);
    const item = this.items.get(itemId);
    if (!item) throw new MondayRejectedError("InvalidItemIdException");
    for (const [k, v] of Object.entries(values)) this.applyValue(boardId, item, k, v);
    this.mutations.push({ kind: "change", args });
    this.hooks.after?.("change", args);
  }
  async createItem(boardId: string, name: string, values: Record<string, unknown>) {
    const args = { boardId, name, values };
    this.hooks.before?.("create", args);
    const id = String(this.nextId++);
    const item = this.add(boardId, id, {}, { name });
    for (const [k, v] of Object.entries(values)) this.applyValue(boardId, item, k, v);
    this.mutations.push({ kind: "create", args: { ...args, id } });
    this.hooks.after?.("create", args);
    return id;
  }
  async archiveItem(itemId: string) {
    const args = { itemId };
    this.hooks.before?.("archive", args);
    const item = this.items.get(itemId);
    if (!item) throw new MondayRejectedError("InvalidItemIdException");
    item.state = "archived";
    this.mutations.push({ kind: "archive", args });
    this.hooks.after?.("archive", args);
  }

  /** Mutations that touch target boards (not control columns on subitem/parent boards). */
  targetMutations() {
    return this.mutations.filter((m) => m.kind === "archive" || m.kind === "create" || (m.kind === "change" && ![PARENT_BOARD_ID, SUBITEM_BOARD_ID].includes(m.args.boardId)));
  }
  col(id: string, col: string) {
    return this.items.get(id)?.columns[col]?.text ?? null;
  }
}

export const lost = () => new MondayUncertainError("response lost");
