import type { FastifyInstance } from "fastify";
import { isItmoIdConfigured, isSupabaseServerConfigured, isYouGileConfigured } from "../../config/env.js";

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
    version: "0.1.0",
  }));
}
