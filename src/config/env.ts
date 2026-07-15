import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_SITE_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TELEGRAM_PARTICIPANT_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ORG_BOT_TOKEN: z.string().optional(),
  PARTICIPANT_BOT_SERVICE_TOKEN: z.string().min(24).optional(),
  ORG_BOT_SERVICE_TOKEN: z.string().min(24).optional(),
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86400),
  YOUGILE_BASE_URL: z.string().url().default("https://yougile.com/api-v2"),
  YOUGILE_API_KEY: z.string().optional(),
  YOUGILE_PROJECT_ID: z.string().optional(),
  ITMO_ID_ISSUER_URL: z.string().url().optional(),
  ITMO_ID_CLIENT_ID: z.string().optional(),
  ITMO_ID_CLIENT_SECRET: z.string().optional(),
  ITMO_ID_REDIRECT_URI: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const isSupabaseServerConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
export const isItmoIdConfigured = Boolean(
  env.ITMO_ID_ISSUER_URL && env.ITMO_ID_CLIENT_ID && env.ITMO_ID_CLIENT_SECRET && env.ITMO_ID_REDIRECT_URI,
);
export const isYouGileConfigured = Boolean(env.YOUGILE_API_KEY);
