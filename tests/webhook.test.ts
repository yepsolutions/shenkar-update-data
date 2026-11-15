import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { silentLogger } from "../src/logger";
import { Store } from "../src/store/store";
import { createHmac } from "node:crypto";

const TOKEN = "t".repeat(32);
function setup(extra: Record<string, string> = {}) {
  const config = loadConfig({ MONDAY_API_TOKEN: "x".repeat(20), WEBHOOK_TOKEN: TOKEN, ADMIN_TOKEN: "a".repeat(32), ...extra });
  const store = new Store(":memory:");
  return { store, app: createApp({ store, log: silentLogger, config }) };
}
const ev = (over: Record<string, unknown> = {}) => ({
  event: {
    boardId: 5107603016,
    pulseId: 3354695148,
    parentItemId: 3354687615,
    columnId: "color_mm90s5mz",
    value: { label: { index: 1, text: "מאושר" } },
    ...over,
  },
});

describe("webhook", () => {
  it("echoes the challenge immediately, before auth or any processing", async () => {
    const { app, store } = setup();
    const r = await request(app).post("/webhooks/monday").send({ challenge: "abc-123" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ challenge: "abc-123" });
    expect(store.pendingJobCount()).toBe(0);
  });

  it("rejects unauthenticated events", async () => {
    const { app, store } = setup();
    const r = await request(app).post("/webhooks/monday").send(ev());
    expect(r.status).toBe(401);
    expect(store.pendingJobCount()).toBe(0);
  });

  it("enqueues an approved subitem change and acks 200", async () => {
    const { app, store } = setup();
    const r = await request(app).post(`/webhooks/monday?token=${TOKEN}`).send(ev());
    expect(r.status).toBe(200);
    expect(store.pendingJobCount()).toBe(1);
  });

  it("accepts a valid monday JWT instead of the token", async () => {
    const secret = "s".repeat(20);
    const { app, store } = setup({ MONDAY_SIGNING_SECRET: secret });
    const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    const r = await request(app).post("/webhooks/monday").set("Authorization", `${h}.${p}.${s}`).send(ev());
    expect(r.status).toBe(200);
    expect(store.pendingJobCount()).toBe(1);
    const bad = await request(app).post("/webhooks/monday").set("Authorization", `${h}.${p}.x${s}`).send(ev());
    expect(bad.status).toBe(401);
  });

  it.each([
    ["rejected status", { value: { label: { text: "נדחה" } } }],
    ["pending status", { value: { label: { text: "ממתין לאישור" } } }],
    ["wrong column", { columnId: "color_mm90k1tq" }],
    ["wrong board", { boardId: 999 }],
    ["no item", { pulseId: undefined }],
  ])("ignores %s", async (_n, over) => {
    const { app, store } = setup();
    const r = await request(app).post(`/webhooks/monday?token=${TOKEN}`).send(ev(over));
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBeTruthy();
    expect(store.pendingJobCount()).toBe(0);
  });

  it("collapses duplicate deliveries into one pending job", async () => {
    const { app, store } = setup();
    for (let i = 0; i < 3; i++) await request(app).post(`/webhooks/monday?token=${TOKEN}`).send(ev());
    expect(store.pendingJobCount()).toBe(1);
  });

  it("rejects malformed payloads", async () => {
    const { app } = setup();
    const r = await request(app).post(`/webhooks/monday?token=${TOKEN}`).send({ nope: 1 });
    expect(r.status).toBe(400);
  });
});
