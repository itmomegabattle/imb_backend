import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { corsOrigins, env } from "./config/env.js";
import { authRoutes } from "./modules/auth/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { profileRoutes } from "./modules/profiles/routes.js";
import { telegramRoutes } from "./modules/telegram/routes.js";
import { participantRoutes } from "./modules/participants/routes.js";
import { youGileRoutes } from "./modules/yougile/routes.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(telegramRoutes);
  await app.register(profileRoutes);
  await app.register(participantRoutes, { prefix: "/api/v1/participant" });
  await app.register(youGileRoutes, { prefix: "/api/v1/integrations/yougile" });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return reply.code(500).send({
      error: "Internal server error",
      message: env.NODE_ENV === "production" ? "Что-то пошло не так" : message,
    });
  });

  return app;
}
