import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { corsOrigins, env } from "./config/env.js";
import { authRoutes } from "./modules/auth/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { profileRoutes } from "./modules/profiles/routes.js";
import { participantRoutes } from "./modules/participants/routes.js";
import { youGileRoutes } from "./modules/yougile/routes.js";
import { contentRoutes } from "./modules/content/routes.js";
import { socialRoutes } from "./modules/social/routes.js";
import { gameRoutes } from "./modules/game/routes.js";
import { organizerRoutes } from "./modules/organizer/routes.js";
import { mediaRoutes } from "./modules/media/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { internalRoutes } from "./modules/internal/routes.js";
import { itmoEventsRoutes } from "./modules/itmo-events/routes.js";
import { startWorker } from "./services/worker.js";
import { ZodError } from "zod";

export async function buildApp() {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(profileRoutes);
  await app.register(participantRoutes, { prefix: "/api/v1/participant" });
  await app.register(youGileRoutes, { prefix: "/api/v1/integrations/yougile" });
  await app.register(contentRoutes);
  await app.register(socialRoutes);
  await app.register(gameRoutes);
  await app.register(organizerRoutes);
  await app.register(mediaRoutes);
  await app.register(adminRoutes);
  await app.register(internalRoutes);
  await app.register(itmoEventsRoutes);

  const stopWorker = startWorker(app.log);
  app.addHook("onClose", async () => stopWorker());

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (error instanceof ZodError) return reply.code(400).send({ error: "Некорректные данные", details: error.flatten() });
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    return reply.code(statusCode).send({
      error: "Internal server error",
      message: env.NODE_ENV === "production" ? "Что-то пошло не так" : message,
    });
  });

  return app;
}
