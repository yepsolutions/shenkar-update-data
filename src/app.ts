import express from "express";
import type { Config } from "./config";
import { Executor } from "./execution/executor";
import type { Logger } from "./logger";
import type { Store } from "./store/store";
import { safeEqual } from "./webhook/auth";
import { webhookRouter } from "./webhook/router";

export function createApp(deps: { store: Store; log: Logger; config: Config; executor?: Executor; kick?: () => Promise<void> }) {
  const { store, log, config, kick } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(webhookRouter({ store, log, config, kick }));

  // Minimal operator endpoints (disabled unless ADMIN_TOKEN is set).
  const admin = express.Router();
  admin.use((req, res, next) => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!config.ADMIN_TOKEN || !safeEqual(t, config.ADMIN_TOKEN)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  admin.get("/changes/:id", (req, res) => {
    const r = store.get(String(req.params.id));
    if (!r) return void res.status(404).json({ error: "not_found" });
    res.json({
      changeId: r.change_id,
      subitemId: r.subitem_id,
      state: r.state,
      phase: r.phase,
      attempts: r.attempts,
      errorCode: r.error_code,
      resultItemId: r.result_item_id,
    });
  });
  // After a human verified monday: declare the uncertain change applied / not applied.
  admin.post("/changes/:id/resolve", (req, res) => {
    const outcome = req.body?.outcome;
    if (outcome !== "applied" && outcome !== "not_applied") return void res.status(400).json({ error: "bad_outcome" });
    const ok = store.resolveManually(String(req.params.id), outcome);
    log.warn("manual_resolution", { changeId: String(req.params.id), outcome });
    res.status(ok ? 200 : 409).json({ ok });
  });
  app.use("/admin", admin);

  return app;
}
