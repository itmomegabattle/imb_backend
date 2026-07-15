import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

const key = new TextEncoder().encode(env.SESSION_SECRET);

export interface OidcState {
  returnTo: string;
  linkProfileId?: string;
  nonce: string;
}

export async function issueOidcState(state: OidcState) {
  return new SignJWT(state as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("itmomegabattle-backend")
    .setAudience("itmo-id-state")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

export async function verifyOidcState(token: string): Promise<OidcState> {
  const { payload } = await jwtVerify(token, key, { issuer: "itmomegabattle-backend", audience: "itmo-id-state" });
  if (typeof payload.returnTo !== "string" || typeof payload.nonce !== "string") throw new Error("Invalid OIDC state");
  return { returnTo: payload.returnTo, nonce: payload.nonce, linkProfileId: typeof payload.linkProfileId === "string" ? payload.linkProfileId : undefined };
}

export function randomCode(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
export function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

let cachedDiscovery: { value: OidcDiscovery; expiresAt: number } | undefined;
export async function discoverOidc(): Promise<OidcDiscovery> {
  if (cachedDiscovery && cachedDiscovery.expiresAt > Date.now()) return cachedDiscovery.value;
  if (!env.ITMO_ID_ISSUER_URL) throw new Error("ITMO_ID_ISSUER_URL is not configured");
  const response = await fetch(`${env.ITMO_ID_ISSUER_URL.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
  const value = await response.json() as OidcDiscovery;
  if (!value.authorization_endpoint || !value.token_endpoint || !value.userinfo_endpoint || !value.jwks_uri) throw new Error("OIDC discovery is incomplete");
  cachedDiscovery = { value, expiresAt: Date.now() + 3600_000 }; return value;
}

export async function verifyOidcIdToken(token: string, nonce: string, discovery: OidcDiscovery) {
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jwtVerify(token, jwks, { issuer: discovery.issuer, audience: env.ITMO_ID_CLIENT_ID });
  if (payload.nonce !== nonce) throw new Error("OIDC nonce mismatch");
  return payload;
}
