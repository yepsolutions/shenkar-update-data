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
    const r = await request(app).post("/handle-approval").send({ challenge: "abc-123" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ challenge: "abc-123" });
    expect(store.pendingJobCount()).toBe(0);
  });

  it("rejects unauthenticated events", async () => {
    const { app, store } = setup();
    const r = await request(app).post("/handle-approval").send(ev());
    expect(r.status).toBe(401);
    expect(store.pendingJobCount()).toBe(0);
  });

  it("works without any token when none is configured (open endpoint)", async () => {
    const config = loadConfig({ MONDAY_API_TOKEN: "x".repeat(20) });
    const store = new Store(":memory:");
    const app = createApp({ store, log: silentLogger, config });
    const r = await request(app).post("/handle-approval").send(ev());
    expect(r.status).toBe(200);
    expect(store.pendingJobCount()).toBe(1);
    expect((await request(app).post("/handle-approval").send({ challenge: "c" })).body).toEqual({ challenge: "c" });
  });

  it("enqueues an approved subitem change and acks 200", async () => {
    const { app, store } = setup();
    const r = await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev());
    expect(r.status).toBe(200);
    expect(store.pendingJobCount()).toBe(1);
  });

  it("accepts a valid monday JWT instead of the token", async () => {
    const secret = "s".repeat(20);
    const { app, store } = setup({ MONDAY_SIGNING_SECRET: secret });
    const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    const r = await request(app).post("/handle-approval").set("Authorization", `${h}.${p}.${s}`).send(ev());
    expect(r.status).toBe(200);
    expect(store.pendingJobCount()).toBe(1);
    const bad = await request(app).post("/handle-approval").set("Authorization", `${h}.${p}.x${s}`).send(ev());
    expect(bad.status).toBe(401);
  });

  it.each([
    ["rejected", "נדחה"],
    ["pending approval", "ממתין לאישור"],
  ])("a %s decision enqueues a parent-status refresh, not a change", async (_n, label) => {
    const { app, store } = setup();
    const r = await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev({ value: { label: { text: label } } }));
    expect(r.status).toBe(200);
    expect(r.body.parentRefresh).toBe(true);
    const job = store.db.prepare("SELECT kind FROM jobs").get() as { kind: string };
    expect(job.kind).toBe("parent");
  });

  it("an unknown decision label is ignored", async () => {
    const { app, store } = setup();
    const r = await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev({ value: { label: { text: "משהו אחר" } } }));
    expect(r.body.ignored).toBe("unsupported_decision");
    expect(store.pendingJobCount()).toBe(0);
  });

  it("change and parent jobs for the same subitem are tracked separately", async () => {
    const { app, store } = setup();
    await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev());
    await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev({ value: { label: { text: "נדחה" } } }));
    expect(store.pendingJobCount()).toBe(2);
  });

  it.each([
    ["wrong column", { columnId: "color_mm90k1tq" }],
    ["wrong board", { boardId: 999 }],
    ["no item", { pulseId: undefined }],
  ])("ignores %s", async (_n, over) => {
    const { app, store } = setup();
    const r = await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev(over));
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBeTruthy();
    expect(store.pendingJobCount()).toBe(0);
  });

  it("collapses duplicate deliveries into one pending job", async () => {
    const { app, store } = setup();
    for (let i = 0; i < 3; i++) await request(app).post(`/handle-approval?token=${TOKEN}`).send(ev());
    expect(store.pendingJobCount()).toBe(1);
  });

  it("rejects malformed payloads", async () => {
    const { app } = setup();
    const r = await request(app).post(`/handle-approval?token=${TOKEN}`).send({ nope: 1 });
    expect(r.status).toBe(400);
  });
});
