import "dotenv/config";
import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalEnv = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  schema.optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_SITE_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  SESSION_SECRET: z.string().min(32).default("development-only-session-secret-change-me"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  CRON_SECRET: optionalEnv(z.string().min(24)),
  VAULT_ENCRYPTION_KEY: optionalEnv(z.string().min(32)),
  VAULT_PIN_HASH: optionalEnv(z.string().length(64)),
  SUPABASE_URL: optionalEnv(z.string().url()),
  SUPABASE_SERVICE_ROLE_KEY: optionalEnv(z.string()),
  TELEGRAM_PARTICIPANT_BOT_TOKEN: optionalEnv(z.string()),
  TELEGRAM_BOT_USERNAME: z.string().default(""),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("pypynyaa"),
  PARTICIPANT_BOT_SERVICE_TOKEN: optionalEnv(z.string().min(24)),
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86400),
  ITMO_EVENTS_BASE_URL: optionalEnv(z.string().url()),
  ITMO_EVENTS_API_KEY: optionalEnv(z.string()),
  ITMO_EVENTS_WEBHOOK_SECRET: optionalEnv(z.string().min(16)),
  ITMO_ID_ISSUER_URL: optionalEnv(z.string().url()),
  ITMO_ID_CLIENT_ID: optionalEnv(z.string()),
  ITMO_ID_CLIENT_SECRET: optionalEnv(z.string()),
  ITMO_ID_REDIRECT_URI: optionalEnv(z.string().url()),
  TEMP_MEDIA_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  WORKER_ENABLED: envBoolean.default(false),
  WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(30),
});

export const env = envSchema.parse(process.env);
if (env.NODE_ENV === "production" && env.SESSION_SECRET === "development-only-session-secret-change-me") {
  throw new Error("SESSION_SECRET must be changed in production");
}

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const isSupabaseServerConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
export const isItmoIdConfigured = Boolean(
  env.ITMO_ID_ISSUER_URL && env.ITMO_ID_CLIENT_ID && env.ITMO_ID_CLIENT_SECRET && env.ITMO_ID_REDIRECT_URI,
);
