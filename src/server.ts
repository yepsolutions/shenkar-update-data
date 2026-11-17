import express from "express";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { Executor } from "./execution/executor";
import { Worker } from "./execution/worker";
import { createLogger } from "./logger";
import { MondayClient } from "./monday/client";
import { SchemaGuard } from "./monday/schema";
import { Store } from "./store/store";

/**
 * Unconfigured mode: monday code only lets you set env vars after a first successful
 * deploy, and a deploy succeeds only if the container listens. So with invalid config we
 * listen on PORT, report the problem, and refuse all work (503) instead of crashing.
 */
function startUnconfigured(reason: string): never {
  const port = Number(process.env.PORT) || 8080;
  const app = express();
  app.get("/healthz", (_req, res) => res.status(503).json({ ok: false, configured: false, reason }));
  app.use((_req, res) => res.status(503).json({ error: "service not configured", reason }));
  app.listen(port, () => console.error(`UNCONFIGURED: ${reason}. Listening on ${port}, refusing all requests.`));
  return undefined as never;
}

let loaded: ReturnType<typeof loadConfig> | undefined;
try {
  loaded = loadConfig();
} catch (e) {
  startUnconfigured((e as Error).message);
}
if (loaded) main(loaded);

function main(config: ReturnType<typeof loadConfig>): void {
const log = createLogger(config.LOG_LEVEL);
const store = new Store(config.DB_PATH, Date.now, config.LEASE_SECONDS * 1000, config.MAX_ATTEMPTS);
const api = new MondayClient({ token: config.MONDAY_API_TOKEN, apiVersion: config.MONDAY_API_VERSION });
const executor = new Executor({
  api,
  store,
  schema: new SchemaGuard(api),
  log,
  convert: { phoneCountry: config.DEFAULT_PHONE_COUNTRY },
});
const worker = new Worker(store, executor, log);
const app = createApp({ store, log, config, executor, kick: () => worker.kick(20_000) });

const server = app.listen(config.PORT, () => {
  log.info("listening", { port: config.PORT });
  if (!config.WEBHOOK_TOKEN && !config.MONDAY_SIGNING_SECRET) log.warn("webhook endpoint has no authentication configured");
});
worker.start();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    worker.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
}
