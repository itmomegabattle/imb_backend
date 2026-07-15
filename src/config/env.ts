import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_SITE_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  SESSION_SECRET: z.string().min(32).default("development-only-session-secret-change-me"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  CRON_SECRET: z.string().min(24).optional(),
  VAULT_ENCRYPTION_KEY: z.string().min(32).optional(),
  VAULT_PIN_HASH: z.string().length(64).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TELEGRAM_PARTICIPANT_BOT_TOKEN: z.string().optional(),
  PARTICIPANT_BOT_SERVICE_TOKEN: z.string().min(24).optional(),
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86400),
  ITMO_EVENTS_BASE_URL: z.string().url().optional(),
  ITMO_EVENTS_API_KEY: z.string().optional(),
  ITMO_EVENTS_WEBHOOK_SECRET: z.string().min(16).optional(),
  ITMO_ID_ISSUER_URL: z.string().url().optional(),
  ITMO_ID_CLIENT_ID: z.string().optional(),
  ITMO_ID_CLIENT_SECRET: z.string().optional(),
  ITMO_ID_REDIRECT_URI: z.string().url().optional(),
  TEMP_MEDIA_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  WORKER_ENABLED: z.coerce.boolean().default(false),
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
