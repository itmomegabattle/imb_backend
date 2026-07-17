import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env, isItmoIdConfigured } from "../../config/env.js";
import { db, rolesFor, unwrap } from "../../lib/db.js";
import { upsertIdentity } from "../../lib/identity.js";
import { discoverOidc, issueOidcState, randomCode, sha256, verifyOidcIdToken, verifyOidcState } from "../../lib/oidc.js";
import { issueSession, optionalSession, requireSession } from "../../lib/session.js";
import { TelegramInitDataError, verifyTelegramInitData, verifyTelegramLoginPayload } from "../../lib/telegram-init-data.js";
import { requireService } from "../../lib/service-auth.js";

const telegramSchema = z.object({
  initData: z.string().min(1),
  linkCurrentProfile: z.boolean().default(false),
});

async function sendSession(reply: any, principal: Parameters<typeof issueSession>[0]) {
  const token = await issueSession(principal);
  reply.setCookie("mb_session", token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
    maxAge: env.SESSION_TTL_SECONDS,
  });
  return { token, expiresIn: env.SESSION_TTL_SECONDS, profileId: principal.profileId, roles: principal.roles };
}

export async function authRoutes(app: FastifyInstance) {
  async function serviceSession(request: any, reply: any) {
    const parsed = z.object({ telegramId: z.number().int().positive() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "telegramId обязателен" });
    const identity = unwrap(await db().from("account_identities").select("profile_id").eq("provider", "telegram").eq("provider_subject", String(parsed.data.telegramId)).maybeSingle());
    if (!identity) return reply.code(404).send({ error: "Профиль Telegram не найден" });
    const roles = await rolesFor(identity.profile_id);
    return sendSession(reply, { profileId: identity.profile_id, roles, provider: "telegram", providerSubject: String(parsed.data.telegramId) });
  }

  app.post("/auth/service/participant-session", { preHandler: requireService("participant_bot") }, serviceSession);

  app.post("/auth/telegram/session", { preHandler: optionalSession }, async (request, reply) => {
    const parsed = telegramSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные данные Telegram", details: parsed.error.flatten() });
    const botToken = env.TELEGRAM_PARTICIPANT_BOT_TOKEN;
    if (!botToken) return reply.code(503).send({ error: "Telegram-бот не настроен" });
    try {
      const verified = verifyTelegramInitData(parsed.data.initData, botToken, env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS);
      const identity = await upsertIdentity({
        provider: "telegram",
        subject: String(verified.user.id),
        username: verified.user.username,
        fullName: [verified.user.first_name, verified.user.last_name].filter(Boolean).join(" "),
        avatarUrl: verified.user.photo_url,
        metadata: { languageCode: verified.user.language_code, source: "participant_bot" },
        linkToProfileId: parsed.data.linkCurrentProfile ? request.principal?.profileId : undefined,
      });
      return sendSession(reply, { ...identity, provider: "telegram", providerSubject: String(verified.user.id) });
    } catch (error) {
      if (error instanceof TelegramInitDataError) return reply.code(401).send({ error: error.message });
      throw error;
    }
  });

  app.post("/auth/telegram/login", async (request, reply) => {
    if (!env.TELEGRAM_PARTICIPANT_BOT_TOKEN) return reply.code(503).send({ error: "Telegram-бот не настроен" });
    const parsed = z.object({
      id: z.coerce.number().int().positive(), first_name: z.string().min(1), last_name: z.string().optional(),
      username: z.string().optional(), photo_url: z.string().url().optional(), auth_date: z.coerce.number().int(), hash: z.string().length(64),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные данные Telegram", details: parsed.error.flatten() });
    try {
      const user = verifyTelegramLoginPayload(parsed.data, env.TELEGRAM_PARTICIPANT_BOT_TOKEN, env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS);
      const identity = await upsertIdentity({
        provider: "telegram", subject: String(user.id), username: user.username,
        fullName: [user.first_name, user.last_name].filter(Boolean).join(" "), avatarUrl: user.photo_url,
        metadata: { source: "telegram_login_widget" },
      });
      return sendSession(reply, { ...identity, provider: "telegram", providerSubject: String(user.id) });
    } catch (error) {
      if (error instanceof TelegramInitDataError) return reply.code(401).send({ error: error.message });
      throw error;
    }
  });

  app.get("/auth/itmo/start", { preHandler: optionalSession }, async (request, reply) => {
    if (!isItmoIdConfigured) return reply.code(501).send({ error: "ITMO.ID пока не настроен" });
    const query = z.object({ returnTo: z.string().url().optional(), link: z.coerce.boolean().optional() }).parse(request.query);
    const siteOrigin = new URL(env.PUBLIC_SITE_URL).origin;
    const requestedReturn = query.returnTo ? new URL(query.returnTo) : null;
    const returnTo = requestedReturn?.origin === siteOrigin ? requestedReturn.toString() : `${env.PUBLIC_SITE_URL}/auth/callback`;
    const nonce = randomCode(20);
    const state = await issueOidcState({ returnTo, nonce, linkProfileId: query.link ? request.principal?.profileId : undefined });
    const discovery = await discoverOidc();
    const authUrl = new URL(discovery.authorization_endpoint);
    for (const [key, value] of Object.entries({ client_id: env.ITMO_ID_CLIENT_ID!, redirect_uri: env.ITMO_ID_REDIRECT_URI!, response_type: "code", scope: "openid profile email", state, nonce })) authUrl.searchParams.set(key, value);
    return reply.redirect(authUrl.toString());
  });

  app.get("/auth/itmo/callback", async (request, reply) => {
    if (!isItmoIdConfigured) return reply.code(501).send({ error: "ITMO.ID пока не настроен" });
    const query = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(request.query);
    if (query.error || !query.code || !query.state) return reply.redirect(`${env.PUBLIC_SITE_URL}/auth?itmo_error=${encodeURIComponent(query.error ?? "missing_code")}`);
    const state = await verifyOidcState(query.state);
    const discovery = await discoverOidc();
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, client_id: env.ITMO_ID_CLIENT_ID!, client_secret: env.ITMO_ID_CLIENT_SECRET!, redirect_uri: env.ITMO_ID_REDIRECT_URI! }),
    });
    const tokens = await tokenResponse.json() as { access_token?: string; id_token?: string; error?: string };
    if (!tokenResponse.ok || !tokens.access_token) return reply.redirect(`${state.returnTo}?itmo_error=${encodeURIComponent(tokens.error ?? "token_exchange")}`);
    if (!tokens.id_token) return reply.redirect(`${state.returnTo}?itmo_error=missing_id_token`);
    await verifyOidcIdToken(tokens.id_token, state.nonce, discovery);
    const userResponse = await fetch(discovery.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const user = await userResponse.json() as Record<string, unknown>;
    if (!userResponse.ok || typeof user.sub !== "string") return reply.redirect(`${state.returnTo}?itmo_error=userinfo`);
    const identity = await upsertIdentity({ provider: "itmo_id", subject: user.sub, username: String(user.preferred_username ?? ""), fullName: String(user.name ?? ""), isuNumber: user.isu ? String(user.isu) : null, email: user.email ? String(user.email) : null, metadata: user, linkToProfileId: state.linkProfileId });
    const code = randomCode();
    unwrap(await db().from("auth_exchange_codes").insert({ code_hash: sha256(code), profile_id: identity.profileId, provider: "itmo_id", provider_subject: user.sub, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }));
    const redirect = new URL(state.returnTo); redirect.searchParams.set("code", code);
    return reply.redirect(redirect.toString());
  });

  app.post("/auth/itmo/exchange", async (request, reply) => {
    const parsed = z.object({ code: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректный код" });
    const row = unwrap(await db().from("auth_exchange_codes").select("*").eq("code_hash", sha256(parsed.data.code)).is("consumed_at", null).gt("expires_at", new Date().toISOString()).maybeSingle());
    if (!row) return reply.code(401).send({ error: "Код истёк или уже использован" });
    unwrap(await db().from("auth_exchange_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id));
    return sendSession(reply, { profileId: row.profile_id, roles: await rolesFor(row.profile_id), provider: "itmo_id", providerSubject: row.provider_subject });
  });

  app.get("/auth/me", { preHandler: optionalSession }, async (request) => {
    if (!request.principal) {
      return { authenticated: false, principal: null, profile: null };
    }
    const profile = unwrap(await db().from("profiles").select("*").eq("id", request.principal!.profileId).maybeSingle());
    return { authenticated: true, principal: request.principal, profile };
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie("mb_session", { path: "/" });
    return { ok: true };
  });
}
