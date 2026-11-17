import { z } from "zod";

const emptyToUndef = (v: unknown) => (v === "" ? undefined : v);
const bool = (def: boolean) =>
  z.preprocess(emptyToUndef, z.enum(["true", "false"]).default(def ? "true" : "false")).transform((v) => v === "true");

const schema = z.object({
  MONDAY_API_TOKEN: z.string().min(10),
  MONDAY_API_VERSION: z.preprocess(emptyToUndef, z.string().default("2025-10")),
  /** Optional. When set, webhook requests must carry ?token=<value>. */
  WEBHOOK_TOKEN: z.preprocess(emptyToUndef, z.string().min(24, "WEBHOOK_TOKEN must be at least 24 characters").optional()),
  MONDAY_SIGNING_SECRET: z.preprocess(emptyToUndef, z.string().min(10).optional()),
  ADMIN_TOKEN: z.preprocess(emptyToUndef, z.string().min(24).optional()),
  DB_PATH: z.preprocess(emptyToUndef, z.string().default("./data/state.sqlite")),
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(3000)),
  /** Live writes happen only when DRY_RUN is explicitly the string "false". */
  DRY_RUN: bool(true),
  LEASE_SECONDS: z.preprocess(emptyToUndef, z.coerce.number().int().min(10).default(120)),
  MAX_ATTEMPTS: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).default(5)),
  DEFAULT_PHONE_COUNTRY: z.preprocess(emptyToUndef, z.string().length(2).default("IL")),
  LOG_LEVEL: z.preprocess(emptyToUndef, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${keys}`);
  }
  return parsed.data;
}
