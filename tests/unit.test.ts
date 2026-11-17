import { describe, expect, it } from "vitest";
import { createLogger, sanitize } from "../src/logger";
import { loadConfig } from "../src/config";
import { comparableOfItem, convertProposed, resolveCountry } from "../src/mapping/convert";
import { MondayClient } from "../src/monday/client";
import { MondayRejectedError, MondayTransientError, MondayUncertainError } from "../src/errors";

const o = { phoneCountry: "IL" };
const def = { id: "s", type: "status", labels: [{ id: 1, label: "כן" }, { id: 2, label: "לא" }] };

describe("convert", () => {
  it("builds monday value shapes", () => {
    expect(convertProposed("status", "כן", def, o).monday).toEqual({ label: "כן" });
    expect(convertProposed("phone", "054-555 5555", undefined, o).monday).toEqual({ phone: "0545555555", countryShortName: "IL" });
    expect(convertProposed("checkbox", "כן", undefined, o).monday).toEqual({ checked: "true" });
    expect(convertProposed("country", "ישראל", undefined, o).monday).toMatchObject({ countryCode: "IL" });
    expect(convertProposed("text", "", undefined, o).monday).toBe("");
    expect(convertProposed("date", "", undefined, o).monday).toBeNull();
  });
  it("rejects bad values", () => {
    expect(() => convertProposed("status", "אולי", def, o)).toThrow();
    expect(() => convertProposed("numbers", "12a", undefined, o)).toThrow();
    expect(() => convertProposed("email", "x", undefined, o)).toThrow();
    expect(() => convertProposed("date", "2026-13-40", undefined, o)).toThrow();
    expect(() => convertProposed("link", "javascript:alert(1)", undefined, o)).toThrow();
    expect(() => resolveCountry("Narnia")).toThrow();
  });
  it("compares phones across +972 / 0 forms and numbers numerically", () => {
    const a = convertProposed("phone", "+972544456148", undefined, o).comparable;
    expect(comparableOfItem("phone", { type: "phone", text: "0544456148", value: null })).toBe(a);
    expect(comparableOfItem("numbers", { type: "numbers", text: "2026.0", value: null })).toBe("2026");
  });
});

describe("logging & config", () => {
  it("redacts sensitive keys", () => {
    const s = sanitize({ nationalId: "0123", email: "a@b", changeId: "CHG-1", name: "דנה", newValue: "x" });
    expect(s).toEqual({ nationalId: "[redacted]", email: "[redacted]", changeId: "CHG-1", name: "[redacted]", newValue: "[redacted]" });
    const lines: string[] = [];
    createLogger("info", (l) => lines.push(l)).info("x", { changeId: "CHG-1", token: "secret" });
    expect(lines[0]).not.toContain("secret");
  });
  it("defaults to dry-run and requires explicit DRY_RUN=false", () => {
    const base = { MONDAY_API_TOKEN: "x".repeat(20), WEBHOOK_TOKEN: "w".repeat(24) };
    expect(loadConfig(base).DRY_RUN).toBe(true);
    expect(loadConfig({ ...base, DRY_RUN: "" }).DRY_RUN).toBe(true);
    expect(loadConfig({ ...base, DRY_RUN: "false" }).DRY_RUN).toBe(false);
    expect(() => loadConfig({ ...base, WEBHOOK_TOKEN: "short" })).toThrow(/WEBHOOK_TOKEN/);
    expect(loadConfig({ MONDAY_API_TOKEN: base.MONDAY_API_TOKEN }).WEBHOOK_TOKEN).toBeUndefined();
    expect(loadConfig({ ...base, WEBHOOK_TOKEN: "" }).WEBHOOK_TOKEN).toBeUndefined();
  });
});

describe("MondayClient error classification", () => {
  const client = (fn: typeof fetch) => new MondayClient({ token: "t".repeat(20), apiVersion: "2025-10", fetchImpl: fn, sleep: async () => {}, readRetries: 1 });
  const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("mutation: 5xx / network / unknown error code = uncertain; known validation code = rejected", async () => {
    await expect(client(json(500, {})).archiveItem("1")).rejects.toBeInstanceOf(MondayUncertainError);
    await expect(client((async () => { throw new Error("net"); }) as any).archiveItem("1")).rejects.toBeInstanceOf(MondayUncertainError);
    await expect(client(json(200, { errors: [{ message: "x", extensions: { code: "SomethingNew" } }] })).archiveItem("1")).rejects.toBeInstanceOf(MondayUncertainError);
    await expect(client(json(200, { errors: [{ message: "x", extensions: { code: "ColumnValueException" } }] })).archiveItem("1")).rejects.toBeInstanceOf(MondayRejectedError);
  });
  it("mutation is never retried", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    await client(f).archiveItem("1").catch(() => {});
    expect(n).toBe(1);
  });
  it("reads retry then surface a transient error", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response("{}", { status: 429 }); }) as unknown as typeof fetch;
    await expect(client(f).getItem("1")).rejects.toBeInstanceOf(MondayTransientError);
    expect(n).toBe(2);
  });
  it("sends token/version headers and parses item values", async () => {
    let seen: any;
    const f = (async (_u: any, init: any) => {
      seen = init;
      return new Response(JSON.stringify({ data: { items: [{ id: 5, name: "n", state: "active", board: { id: 9 }, parent_item: { id: 7 }, column_values: [{ id: "a", type: "dropdown", text: "x", value: '{"ids":[1]}' }] }] } }));
    }) as unknown as typeof fetch;
    const item = await client(f).getItem("5");
    expect(seen.headers["API-Version"]).toBe("2025-10");
    expect(item).toMatchObject({ id: "5", boardId: "9", parentId: "7" });
    expect(item!.columns.a!.value).toEqual({ ids: [1] });
  });
});
