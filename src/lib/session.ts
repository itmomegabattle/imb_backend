import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { db, rolesFor, unwrap } from "./db.js";

export type EcosystemRole = "participant" | "admin" | "site_admin";

export interface SessionPrincipal {
  profileId: string;
  roles: EcosystemRole[];
  provider: "telegram" | "itmo_id" | "supabase";
  providerSubject: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: SessionPrincipal;
  }
}

const key = new TextEncoder().encode(env.SESSION_SECRET);

export async function issueSession(principal: SessionPrincipal) {
  return new SignJWT({ roles: principal.roles, provider: principal.provider, providerSubject: principal.providerSubject })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(principal.profileId)
    .setIssuer("itmomegabattle-backend")
    .setAudience("itmomegabattle-clients")
    .setIssuedAt()
    .setExpirationTime(`${env.SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySession(token: string): Promise<SessionPrincipal> {
  const { payload } = await jwtVerify(token, key, {
    issuer: "itmomegabattle-backend",
    audience: "itmomegabattle-clients",
  });
  if (!payload.sub || !Array.isArray(payload.roles) || typeof payload.provider !== "string" || typeof payload.providerSubject !== "string") {
    throw new Error("Invalid session payload");
  }
  return {
    profileId: payload.sub,
    roles: payload.roles as EcosystemRole[],
    provider: payload.provider as SessionPrincipal["provider"],
    providerSubject: payload.providerSubject,
  };
}

function bearer(request: FastifyRequest) {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : request.cookies?.mb_session;
}

export async function optionalSession(request: FastifyRequest) {
  const token = bearer(request);
  if (!token) return;
  try {
    request.principal = await verifySession(token);
  } catch {
    request.principal = undefined;
  }
}

export async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  await optionalSession(request);
  if (!request.principal) return reply.code(401).send({ error: "Требуется авторизация" });
  const profile = unwrap(await db().from("profiles").select("is_banned,deleted_at").eq("id", request.principal.profileId).maybeSingle());
  if (!profile || profile.is_banned || profile.deleted_at) {
    request.principal = undefined;
    return reply.code(403).send({ error: "Профиль заблокирован или удалён" });
  }
  request.principal.roles = await rolesFor(request.principal.profileId);
}

export function requireRole(...roles: EcosystemRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const rejected = await requireSession(request, reply);
    if (rejected || !request.principal) return rejected;
    if (!request.principal.roles.some((role) => roles.includes(role))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
  };
}

export const adminRoles: EcosystemRole[] = ["admin", "site_admin"];
