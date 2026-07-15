import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

export type ServiceName = "participant_bot";

function readToken(request: FastifyRequest) {
  const explicit = request.headers["x-service-token"];
  if (typeof explicit === "string") return explicit;
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function equalSecret(actual: string | undefined, expected: string | undefined) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireService(...services: ServiceName[]) {
  return async function serviceAuth(request: FastifyRequest, reply: FastifyReply) {
    const token = readToken(request);
    const accepted = services.some((service) =>
      equalSecret(token, env.PARTICIPANT_BOT_SERVICE_TOKEN),
    );
    if (!accepted) {
      return reply.code(401).send({ error: "Invalid service credentials" });
    }
  };
}
