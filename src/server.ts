import { createApp } from "./app";
import { loadConfig } from "./config";
import { Executor } from "./execution/executor";
import { Worker } from "./execution/worker";
import { createLogger } from "./logger";
import { MondayClient } from "./monday/client";
import { SchemaGuard } from "./monday/schema";
import { Store } from "./store/store";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const store = new Store(config.DB_PATH, Date.now, config.LEASE_SECONDS * 1000, config.MAX_ATTEMPTS);
const api = new MondayClient({ token: config.MONDAY_API_TOKEN, apiVersion: config.MONDAY_API_VERSION });
const executor = new Executor({
  api,
  store,
  schema: new SchemaGuard(api),
  log,
  dryRun: config.DRY_RUN,
  convert: { phoneCountry: config.DEFAULT_PHONE_COUNTRY },
});
const worker = new Worker(store, executor, log);
const app = createApp({ store, log, config, executor });

const server = app.listen(config.PORT, () => {
  log.info("listening", { port: config.PORT, dryRun: config.DRY_RUN });
  if (!config.WEBHOOK_TOKEN && !config.MONDAY_SIGNING_SECRET) log.warn("webhook endpoint has no authentication configured");
  if (config.DRY_RUN) log.warn("DRY_RUN is on: monday is read-only, nothing will be written");
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
