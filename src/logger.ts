export type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys that may carry personal data or secrets; never emitted. */
const SENSITIVE = /(national|alumni_?id|id_entered|email|phone|name|value|token|secret|authorization|payload|field_values|text)/i;

export interface Logger {
  log(level: Level, event: string, fields?: Record<string, unknown>): void;
  debug(event: string, f?: Record<string, unknown>): void;
  info(event: string, f?: Record<string, unknown>): void;
  warn(event: string, f?: Record<string, unknown>): void;
  error(event: string, f?: Record<string, unknown>): void;
}

export function sanitize(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
    } else if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) {
      out[k] = v;
    } else if (v instanceof Error) {
      out[k] = v.name;
    } else {
      out[k] = "[object]";
    }
  }
  return out;
}

export function createLogger(minLevel: Level = "info", sink: (line: string) => void = (l) => console.log(l)): Logger {
  const log = (level: Level, event: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitize(fields) }));
  };
  return {
    log,
    debug: (e, f) => log("debug", e, f),
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
  };
}

export const silentLogger: Logger = createLogger("error", () => {});
