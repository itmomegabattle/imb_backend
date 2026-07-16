import type { FastifyInstance } from "fastify";
import { env, isItmoIdConfigured, isSupabaseServerConfigured } from "../../config/env.js";
import { db } from "../../lib/db.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "itmomegabattle-backend",
    checks: {
      supabase: isSupabaseServerConfigured ? "configured" : "missing-env",
      itmoId: isItmoIdConfigured ? "configured" : "missing-env",
    },
    now: new Date().toISOString(),
  }));

  app.get("/version", async () => ({
    name: "itmomegabattle-backend",
    version: "1.0.0",
  }));

  app.get("/ready", async (_request, reply) => {
    if (!isSupabaseServerConfigured) return reply.code(503).send({ ready: false, error: "Supabase не настроен" });
    const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const keyType = key.startsWith("sb_secret_")
      ? "secret"
      : key.startsWith("sb_publishable_")
        ? "publishable"
        : key.startsWith("eyJ")
          ? "legacy-jwt"
          : "invalid-format";
    const required = ["profiles", "account_identities", "notification_queue", "audit_logs", "backend_schema_versions"];
    const checks = await Promise.all(required.map(async (table) => {
      const result = await db().from(table).select("*", { head: true, count: "exact" }).limit(1);
      return {
        table,
        ok: !result.error,
        error: result.error
          ? {
              message: result.error.message || null,
              code: result.error.code || null,
              details: result.error.details || null,
              hint: result.error.hint || null,
            }
          : null,
      };
    }));
    const version = checks.at(-1)?.ok
      ? await db().from("backend_schema_versions").select("version").eq("version", "202607160003_beta_core").maybeSingle()
      : { data: null };
    const ready = checks.every((check) => check.ok) && Boolean(version.data);
    return reply.code(ready ? 200 : 503).send({
      ready,
      schemaVersion: version.data?.version ?? null,
      connection: {
        host: new URL(env.SUPABASE_URL!).hostname,
        keyType,
        keyLength: key.length,
      },
      checks,
      hint: ready ? undefined : "Проверьте код ошибки, SUPABASE_URL и серверный Secret/Service Role key",
    });
  });
}
