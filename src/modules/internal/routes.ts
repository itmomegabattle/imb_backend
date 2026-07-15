import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { runWorkerOnce } from "../../services/worker.js";

function same(left?: string, right?: string) { if (!left || !right) return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export async function internalRoutes(app: FastifyInstance) {
  app.post("/internal/cron", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? request.headers["x-cron-secret"] as string | undefined;
    if (!same(token, env.CRON_SECRET)) return reply.code(401).send({ error: "Invalid cron credentials" });
    return runWorkerOnce(app.log);
  });
}
