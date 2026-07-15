import type { FastifyInstance } from "fastify";
import { isItmoIdConfigured, isSupabaseServerConfigured, isYouGileConfigured } from "../../config/env.js";
import { db } from "../../lib/db.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "itmomegabattle-backend",
    checks: {
      supabase: isSupabaseServerConfigured ? "configured" : "missing-env",
      itmoId: isItmoIdConfigured ? "configured" : "missing-env",
      youGile: isYouGileConfigured ? "configured" : "missing-env",
    },
    now: new Date().toISOString(),
  }));

  app.get("/version", async () => ({
    name: "itmomegabattle-backend",
    version: "1.0.0",
  }));

  app.get("/ready", async (_request, reply) => {
    if (!isSupabaseServerConfigured) return reply.code(503).send({ ready: false, error: "Supabase не настроен" });
    const required = ["profiles", "account_identities", "organizer_meetings", "notification_queue", "audit_logs", "backend_schema_versions"];
    const checks = await Promise.all(required.map(async (table) => {
      const result = await db().from(table).select("*", { head: true, count: "exact" }).limit(1);
      return { table, ok: !result.error, error: result.error?.message };
    }));
    const version = checks.at(-1)?.ok
      ? await db().from("backend_schema_versions").select("version").eq("version", "202607150002_full_platform").maybeSingle()
      : { data: null };
    const ready = checks.every((check) => check.ok) && Boolean(version.data);
    return reply.code(ready ? 200 : 503).send({ ready, schemaVersion: version.data?.version ?? null, checks, hint: ready ? undefined : "Примените все SQL из supabase/migrations по порядку" });
  });
}
