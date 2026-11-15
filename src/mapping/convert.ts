/** Value conversion and comparison per monday column type. */
import { createHash } from "node:crypto";
import type { ColumnDef, ItemColumn } from "../domain";

export type ColType =
  | "text"
  | "long_text"
  | "numbers"
  | "status"
  | "dropdown"
  | "email"
  | "phone"
  | "link"
  | "date"
  | "checkbox"
  | "country";

export class ConversionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ConversionError";
  }
}

export const normText = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

export function normPhone(s: string): string {
  let d = s.replace(/[^\d]/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return d;
}

let countryMap: Map<string, string> | undefined;
function countries(): Map<string, string> {
  if (countryMap) return countryMap;
  const m = new Map<string, string>();
  const he = new Intl.DisplayNames(["he"], { type: "region" });
  const en = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const h = he.of(code);
        const e = en.of(code);
        if (h && h !== code) m.set(normText(h), code);
        if (e && e !== code) m.set(normText(e).toLowerCase(), code);
      } catch {
        /* not a region */
      }
    }
  }
  countryMap = m;
  return m;
}

export function resolveCountry(raw: string): { code: string; name: string } {
  const t = normText(raw);
  const m = countries();
  let code = m.get(t) ?? m.get(t.toLowerCase());
  if (!code && /^[A-Za-z]{2}$/.test(t)) {
    const up = t.toUpperCase();
    if ([...m.values()].includes(up)) code = up;
  }
  if (!code) throw new ConversionError("UNKNOWN_COUNTRY");
  return { code, name: new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code };
}

export interface ConvertOpts {
  phoneCountry: string;
}

export interface Converted {
  /** Value in the shape change_multiple_column_values expects. */
  monday: unknown;
  /** Canonical string for equality comparison with an item's current value. */
  comparable: string;
}

function labelByName(def: ColumnDef | undefined, name: string) {
  const hits = (def?.labels ?? []).filter((l) => l.label === name);
  if (hits.length !== 1) throw new ConversionError(hits.length ? "AMBIGUOUS_LABEL" : "UNKNOWN_LABEL");
  return hits[0]!;
}

export function convertProposed(type: string, rawIn: string, def: ColumnDef | undefined, opts: ConvertOpts): Converted {
  const raw = normText(rawIn);
  if (raw === "") {
    return { monday: type === "text" ? "" : null, comparable: type === "checkbox" ? "false" : "" };
  }
  switch (type) {
    case "text":
      return { monday: raw, comparable: raw };
    case "long_text":
      return { monday: { text: raw }, comparable: raw };
    case "numbers": {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new ConversionError("INVALID_NUMBER");
      return { monday: raw, comparable: String(Number(raw)) };
    }
    case "status": {
      const l = labelByName(def, raw);
      return { monday: { label: l.label }, comparable: l.label };
    }
    case "dropdown": {
      let names: string[];
      if (raw.startsWith("[")) {
        try {
          const arr = JSON.parse(raw);
          if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) throw new Error();
          names = arr.map(normText);
        } catch {
          throw new ConversionError("INVALID_DROPDOWN_VALUE");
        }
      } else {
        names = [raw];
      }
      const ls = names.map((n) => labelByName(def, n));
      return {
        monday: { labels: ls.map((l) => l.label) },
        comparable: ls.map((l) => l.id).sort((a, b) => a - b).join(","),
      };
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new ConversionError("INVALID_EMAIL");
      return { monday: { email: raw, text: raw }, comparable: raw.toLowerCase() };
    }
    case "phone": {
      const cleaned = raw.replace(/[\s\-()]/g, "");
      if (!/^\+?\d{7,15}$/.test(cleaned)) throw new ConversionError("INVALID_PHONE");
      return {
        monday: { phone: cleaned, countryShortName: opts.phoneCountry },
        comparable: normPhone(cleaned),
      };
    }
    case "link": {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new ConversionError("INVALID_URL");
      }
      if (!/^https?:$/.test(u.protocol)) throw new ConversionError("INVALID_URL");
      return { monday: { url: raw, text: raw }, comparable: raw };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw + "T00:00:00Z")))
        throw new ConversionError("INVALID_DATE");
      return { monday: { date: raw }, comparable: raw };
    }
    case "checkbox": {
      const t = raw.toLowerCase();
      let b: boolean;
      if (["true", "1", "כן", "v", "yes"].includes(t)) b = true;
      else if (["false", "0", "לא", "no"].includes(t)) b = false;
      else throw new ConversionError("INVALID_CHECKBOX");
      return { monday: { checked: b ? "true" : "false" }, comparable: String(b) };
    }
    case "country": {
      const c = resolveCountry(raw);
      return { monday: { countryCode: c.code, countryName: c.name }, comparable: c.code };
    }
    default:
      throw new ConversionError("UNSUPPORTED_TYPE");
  }
}

/** Comparable form of a column's current value on a live item. */
export function comparableOfItem(type: string, col: ItemColumn | undefined): string {
  if (!col) return type === "checkbox" ? "false" : "";
  const v = col.value;
  switch (type) {
    case "text":
    case "status":
      return normText(col.text);
    case "long_text":
      return normText(v?.text ?? col.text);
    case "numbers": {
      const t = normText(col.text);
      return t === "" ? "" : String(Number(t));
    }
    case "dropdown": {
      const ids: number[] = Array.isArray(v?.ids) ? v.ids : [];
      return ids.map(Number).sort((a, b) => a - b).join(",");
    }
    case "email":
      return normText(v?.email ?? "").toLowerCase();
    case "phone":
      return normPhone(String(v?.phone ?? col.text ?? ""));
    case "link":
      return normText(v?.url ?? "");
    case "date":
      return normText(v?.date ?? "");
    case "checkbox":
      return String(v?.checked === true || v?.checked === "true");
    case "country":
      return normText(v?.countryCode ?? "");
    default:
      return normText(col.text);
  }
}

/** Hash used for at-rest intent records so personal data is not duplicated in the state DB. */
export const hashComparable = (column: string, comparable: string): string =>
  createHash("sha256").update(`${column}\u0000${comparable}`).digest("hex");
