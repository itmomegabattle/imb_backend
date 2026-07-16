import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireOnboardedSession, requireRole, requireSession } from "../../lib/session.js";

const hashCode = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");

async function dashboard(profileId: string) {
  const season = unwrap(await db().from("seasons").select("id,slug,title,starts_at,ends_at").eq("is_active", true).single());
  if (!season) throw Object.assign(new Error("Активный сезон не найден"), { statusCode: 503 });
  const profile = unwrap(await db().from("profiles").select("id,nickname,full_name,faculty,avatar_url,role_badge").eq("id", profileId).single());
  const [scores, currencies, achievements, registrations] = await Promise.all([
    db().from("score_transactions").select("id,amount,reason,source,created_at").eq("profile_id", profileId).eq("season_id", season.id).order("created_at", { ascending: false }),
    db().from("currency_transactions").select("amount,currencies(code,name,icon_url)").eq("profile_id", profileId).eq("season_id", season.id),
    db().from("profile_achievements").select("amount,granted_at,achievements(code,name,description,icon_url)").eq("profile_id", profileId),
    db().from("event_registrations").select("status,registered_at,project_events(id,name,starts_at,image_url)").eq("profile_id", profileId).neq("status", "cancelled"),
  ]);
  for (const result of [scores, currencies, achievements, registrations]) if (result.error) throw result.error;
  const xp = (scores.data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
  const levels = unwrap(await db().from("game_levels").select("*").order("min_xp")) ?? [];
  const level = [...levels].reverse().find((item) => item.min_xp <= xp) ?? levels[0] ?? { level: 1, title: "Новичок IMB", min_xp: 0 };
  const next = levels.find((item) => item.min_xp > xp) ?? null;
  const balances = new Map<string, { code: string; name: string; iconUrl: string | null; amount: number }>();
  for (const row of currencies.data ?? []) {
    const currency = Array.isArray(row.currencies) ? row.currencies[0] : row.currencies as any;
    if (!currency) continue;
    const current = balances.get(currency.code) ?? { code: currency.code, name: currency.name, iconUrl: currency.icon_url, amount: 0 };
    current.amount += Number(row.amount); balances.set(currency.code, current);
  }
  const rankRows = unwrap(await db().rpc("participant_leaderboard", { p_limit: 3000 }));
  const rank = rankRows.find((row: any) => row.profile_id === profileId)?.place ?? null;
  const facultyBalances = unwrap(await db().from("current_faculty_balances").select("faculty,balance").order("balance", { ascending: false })) ?? [];
  return { season, profile, level: { ...level, xp, next, percent: next ? Math.round(100 * (xp - level.min_xp) / Math.max(1, next.min_xp - level.min_xp)) : 100 }, rank, balances: [...balances.values()], facultyBalances, achievements: achievements.data ?? [], registrations: registrations.data ?? [], history: (scores.data ?? []).slice(0, 20) };
}

export async function gameRoutes(app: FastifyInstance) {
  app.get("/api/v1/game/dashboard", { preHandler: requireSession }, (request) => dashboard(request.principal!.profileId));

  app.get("/api/v1/game/leaderboard", async (request) => {
    const limit = z.coerce.number().int().min(1).max(3000).default(100).parse((request.query as any).limit);
    const participants = unwrap(await db().rpc("participant_leaderboard", { p_limit: limit }));
    const balances = unwrap(await db().from("current_faculty_balances").select("faculty,balance").order("balance", { ascending: false })) ?? [];
    const faculties = balances.map((row: any, index: number) => ({ place: index + 1, faculty: row.faculty, balance: Number(row.balance) }));
    return { participants, faculties };
  });

  app.post("/api/v1/game/transfers", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const body = z.object({ receiverProfileId: z.string().uuid(), amount: z.number().int().min(10), idempotencyKey: z.string().min(12).max(200).optional() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Минимальный перевод — 10", details: body.error.flatten() });
    const key = body.data.idempotencyKey ?? randomBytes(18).toString("hex");
    const result = await db().rpc("transfer_currency", { p_sender_profile_id: request.principal!.profileId, p_receiver_profile_id: body.data.receiverProfileId, p_amount: body.data.amount, p_idempotency_key: key, p_currency_code: "credits" });
    if (result.error) return reply.code(409).send({ error: result.error.message });
    const receiverIdentity = unwrap(await db().from("account_identities").select("profile_id").eq("profile_id", body.data.receiverProfileId).eq("provider", "telegram").maybeSingle());
    if (receiverIdentity && !(result.data as any)?.duplicate) unwrap(await db().from("notification_queue").upsert({ profile_id: body.data.receiverProfileId, bot: "participant", type: "currency.received", payload: { text: `💙 Тебе перевели <b>${body.data.amount}</b> валюты`, amount: body.data.amount }, idempotency_key: `transfer:${key}:notification` }, { onConflict: "idempotency_key", ignoreDuplicates: true }));
    await audit(request.principal!.profileId, "currency.transferred", "profile", body.data.receiverProfileId, { amount: body.data.amount });
    return reply.code(201).send(result.data);
  });

  app.post("/api/v1/game/rewards/redeem", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const parsed = z.object({ code: z.string().trim().min(3).max(100) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Введите код" });
    const result = await db().rpc("redeem_reward_code", { p_profile_id: request.principal!.profileId, p_code_hash: hashCode(parsed.data.code) });
    if (result.error) return reply.code(409).send({ error: result.error.message });
    await audit(request.principal!.profileId, "reward.redeemed", "reward_code", undefined);
    return result.data;
  });

  app.post("/api/v1/admin/game/transactions", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const body = z.object({ profileId: z.string().uuid(), type: z.enum(["xp", "currency"]), amount: z.number().finite().refine((v) => v !== 0), reason: z.string().min(2).max(300), currencyCode: z.string().optional(), idempotencyKey: z.string().max(200).optional() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Некорректная транзакция", details: body.error.flatten() });
    const season = unwrap(await db().from("seasons").select("id").eq("is_active", true).single());
    if (!season) return reply.code(503).send({ error: "Активный сезон не найден" });
    if (body.data.type === "xp") {
      unwrap(await db().from("score_transactions").insert({ profile_id: body.data.profileId, season_id: season.id, amount: Math.trunc(body.data.amount), reason: body.data.reason, source: "manual", created_by: request.principal!.profileId, idempotency_key: body.data.idempotencyKey }));
    } else {
      const currency = unwrap(await db().from("currencies").select("id").eq("code", body.data.currencyCode ?? "credits").single());
      if (!currency) throw new Error("Валюта не найдена");
      unwrap(await db().from("currency_transactions").insert({ profile_id: body.data.profileId, season_id: season.id, currency_id: currency.id, amount: Math.trunc(body.data.amount), reason: body.data.reason, source: "manual", created_by: request.principal!.profileId, idempotency_key: body.data.idempotencyKey }));
    }
    await audit(request.principal!.profileId, "game.transaction", "profile", body.data.profileId, body.data);
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/v1/admin/game/achievements/grant", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const body = z.object({ profileId: z.string().uuid(), achievementCode: z.string().min(2).max(80), amount: z.number().int().min(1).default(1), idempotencyKey: z.string().min(12).max(200).optional() }).parse(request.body);
    const idempotencyKey = body.idempotencyKey ?? randomBytes(18).toString("hex");
    const granted = await db().rpc("grant_achievement", {
      p_profile_id: body.profileId,
      p_achievement_code: body.achievementCode,
      p_amount: body.amount,
      p_granted_by: request.principal!.profileId,
      p_idempotency_key: idempotencyKey,
    });
    if (granted.error) return reply.code(409).send({ error: granted.error.message });
    await audit(request.principal!.profileId, "achievement.granted", "profile", body.profileId, { code: body.achievementCode, amount: body.amount });
    return reply.code(201).send(granted.data);
  });

  app.post("/api/v1/admin/game/reward-codes", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const body = z.object({ code: z.string().min(3).max(100), label: z.string().min(2).max(150), xpAmount: z.number().int().default(0), currencyCode: z.string().optional(), currencyAmount: z.number().optional(), maxRedemptions: z.number().int().positive().optional(), perProfileLimit: z.number().int().positive().default(1), startsAt: z.string().datetime().optional(), expiresAt: z.string().datetime().optional() }).parse(request.body);
    const result = unwrap(await db().from("reward_codes").insert({ code_hash: hashCode(body.code), label: body.label, xp_amount: body.xpAmount, currency_code: body.currencyCode, currency_amount: body.currencyAmount, max_redemptions: body.maxRedemptions, per_profile_limit: body.perProfileLimit, starts_at: body.startsAt, expires_at: body.expiresAt, created_by: request.principal!.profileId }).select("id,label,xp_amount,currency_code,currency_amount,max_redemptions,expires_at,is_active").single());
    if (!result) throw new Error("Не удалось создать код");
    await audit(request.principal!.profileId, "reward.created", "reward_code", result.id, { ...body, code: "[hidden]" });
    return reply.code(201).send(result);
  });

  app.post("/api/v1/events/:eventId/teams", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const body = z.object({ name: z.string().trim().min(2).max(80) }).parse(request.body);
    const event = unwrap(await db().from("project_events").select("id,registration_mode,registration_status,registration_closes_at").eq("id", eventId).single());
    if (!event) return reply.code(404).send({ error: "Мероприятие не найдено" });
    if (event.registration_mode !== "internal_team" || event.registration_status !== "open" || (event.registration_closes_at && Date.parse(event.registration_closes_at) < Date.now())) return reply.code(409).send({ error: "Командная регистрация закрыта" });
    const code = randomBytes(5).toString("hex").toUpperCase();
    const created = await db().rpc("create_event_team", { p_event_id: eventId, p_captain_profile_id: request.principal!.profileId, p_name: body.name, p_code_hash: hashCode(code), p_code_hint: code });
    if (created.error) return reply.code(409).send({ error: created.error.message });
    const team = (created.data as any).team;
    await audit(request.principal!.profileId, "team.created", "event_team", team.id, { eventId });
    return reply.code(201).send(created.data);
  });

  app.post("/api/v1/events/teams/join", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const code = z.object({ code: z.string().trim().min(4).max(30) }).parse(request.body).code;
    const result = await db().rpc("join_event_team", { p_profile_id: request.principal!.profileId, p_code_hash: hashCode(code) });
    if (result.error) return reply.code(409).send({ error: result.error.message });
    await audit(request.principal!.profileId, "team.joined", "event_team", (result.data as any).teamId);
    return reply.code(201).send(result.data);
  });

  app.get("/api/v1/events/:eventId/team", { preHandler: requireSession }, async (request) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const membership = unwrap(await db().from("event_team_members").select("team_id,event_teams!inner(*,event_team_members(profile_id,joined_at,profiles(id,nickname,faculty,avatar_url)))").eq("profile_id", request.principal!.profileId).eq("event_teams.event_id", eventId).maybeSingle());
    if (!membership) return { team: null };
    const team = Array.isArray(membership.event_teams) ? membership.event_teams[0] : membership.event_teams;
    return { team: { ...team, join_code_hint: team.captain_profile_id === request.principal!.profileId ? team.join_code_hint : undefined } };
  });

  app.patch("/api/v1/events/teams/:teamId", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const teamId = (request.params as { teamId: string }).teamId;
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("rename"), name: z.string().trim().min(2).max(80) }),
      z.object({ action: z.literal("rotate_code") }),
      z.object({ action: z.literal("remove_member"), profileId: z.string().uuid() }),
      z.object({ action: z.literal("transfer_captain"), profileId: z.string().uuid() }),
      z.object({ action: z.literal("complete") }),
      z.object({ action: z.literal("cancel") }),
    ]).parse(request.body);
    const team = unwrap(await db().from("event_teams").select("*,project_events(min_team_size,max_team_size,registration_status)").eq("id", teamId).single());
    if (team.captain_profile_id !== request.principal!.profileId) return reply.code(403).send({ error: "Действие доступно только капитану" });
    if (team.status !== "forming" && body.action !== "cancel") return reply.code(409).send({ error: "Зарегистрированный или отменённый состав менять нельзя" });
    let joinCode: string | undefined;
    if (body.action === "rename") unwrap(await db().from("event_teams").update({ name: body.name, updated_at: new Date().toISOString() }).eq("id", teamId));
    if (body.action === "rotate_code") {
      joinCode = randomBytes(5).toString("hex").toUpperCase();
      unwrap(await db().from("event_teams").update({ join_code_hash: hashCode(joinCode), join_code_hint: joinCode, updated_at: new Date().toISOString() }).eq("id", teamId));
    }
    if (body.action === "remove_member") {
      if (body.profileId === request.principal!.profileId) return reply.code(409).send({ error: "Капитан не может удалить себя" });
      unwrap(await db().from("event_team_members").delete().eq("team_id", teamId).eq("profile_id", body.profileId));
    }
    if (body.action === "transfer_captain") {
      const member = unwrap(await db().from("event_team_members").select("profile_id").eq("team_id", teamId).eq("profile_id", body.profileId).maybeSingle());
      if (!member) return reply.code(409).send({ error: "Новый капитан должен состоять в команде" });
      unwrap(await db().from("event_teams").update({ captain_profile_id: body.profileId, updated_at: new Date().toISOString() }).eq("id", teamId));
    }
    if (body.action === "complete") {
      const completed = await db().rpc("complete_event_team", { p_team_id: teamId, p_captain_profile_id: request.principal!.profileId });
      if (completed.error) return reply.code(409).send({ error: completed.error.message });
    }
    if (body.action === "cancel") {
      const cancelled = await db().rpc("cancel_event_team", { p_team_id: teamId, p_captain_profile_id: request.principal!.profileId });
      if (cancelled.error) return reply.code(409).send({ error: cancelled.error.message });
    }
    await audit(request.principal!.profileId, `team.${body.action}`, "event_team", teamId, body);
    return { ok: true, joinCode };
  });

  app.post("/api/v1/events/:eventId/register", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const event = unwrap(await db().from("project_events").select("registration_mode,registration_link").eq("id", eventId).maybeSingle());
    if (!event) return reply.code(404).send({ error: "Мероприятие не найдено" });
    if (event.registration_mode === "external_itmo_events") return reply.code(409).send({ error: "Используйте внешнюю страницу регистрации", registrationLink: event.registration_link });
    if (event.registration_mode === "internal_team") return reply.code(409).send({ error: "Для этого мероприятия нужна команда" });
    const registration = await db().rpc("register_for_event", { p_profile_id: request.principal!.profileId, p_event_id: eventId, p_source: "site" });
    if (registration.error) {
      if (registration.error.message.includes("ITMO_ID_REQUIRED")) return reply.code(428).send({ error: "Для регистрации привяжите ITMO.ID", code: "ITMO_ID_REQUIRED" });
      return reply.code(409).send({ error: "Регистрация сейчас недоступна", details: registration.error.message });
    }
    const result = registration.data as any; const status = result.status;
    if (result.itmoEventsId) unwrap(await db().from("integration_jobs").insert({ integration: "itmo_events", operation: "registration.create", entity_type: "event_registration", entity_id: result.id }));
    unwrap(await db().from("notification_queue").upsert({ profile_id: request.principal!.profileId, bot: "participant", type: "event.registration", payload: { text: `${status === "waitlist" ? "🕓 Вы в листе ожидания" : "✅ Регистрация подтверждена"}\n<b>${result.eventName}</b>${result.startsAt ? `\n${new Date(result.startsAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}` : ""}`, eventId }, idempotency_key: `event:${eventId}:registration:${request.principal!.profileId}` }, { onConflict: "idempotency_key" }));
    await audit(request.principal!.profileId, "event.registered", "event", eventId, { status });
    return reply.code(201).send(result);
  });

  app.delete("/api/v1/events/:eventId/register", { preHandler: requireSession }, async (request) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const registration = unwrap(await db().from("event_registrations").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("event_id", eventId).eq("profile_id", request.principal!.profileId).select("id,itmo_events_registration_id").maybeSingle());
    if (registration?.itmo_events_registration_id) unwrap(await db().from("integration_jobs").insert({ integration: "itmo_events", operation: "registration.cancel", entity_type: "event_registration", entity_id: registration.id, payload: { externalId: registration.itmo_events_registration_id } }));
    await audit(request.principal!.profileId, "event.cancelled", "event", eventId); return { ok: true };
  });

  app.post("/api/v1/events/checkin", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const code = z.object({ code: z.string().min(4).max(100) }).parse(request.body).code;
    const checkin = unwrap(await db().from("event_checkin_codes").select("event_id,project_events(requires_itmo_id)").eq("code_hash", hashCode(code)).eq("is_active", true).lte("starts_at", new Date().toISOString()).gte("expires_at", new Date().toISOString()).maybeSingle());
    if (!checkin) return reply.code(404).send({ error: "Код отметки недействителен" });
    const event = Array.isArray(checkin.project_events) ? checkin.project_events[0] : checkin.project_events as any;
    if (event?.requires_itmo_id) {
      const identity = unwrap(await db().from("account_identities").select("id").eq("profile_id", request.principal!.profileId).eq("provider", "itmo_id").maybeSingle());
      if (!identity) return reply.code(428).send({ error: "Для отметки привяжите ITMO.ID", code: "ITMO_ID_REQUIRED" });
    }
    unwrap(await db().from("event_registrations").upsert({ event_id: checkin.event_id, profile_id: request.principal!.profileId, status: "attended", source: "site", updated_at: new Date().toISOString() }, { onConflict: "event_id,profile_id" }));
    await audit(request.principal!.profileId, "event.checked_in", "event", checkin.event_id); return { ok: true, eventId: checkin.event_id };
  });

  app.post("/api/v1/admin/events/:eventId/checkin-codes", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const body = z.object({ code: z.string().min(4).max(100), startsAt: z.string().datetime(), expiresAt: z.string().datetime() }).parse(request.body);
    const row = unwrap(await db().from("event_checkin_codes").insert({ event_id: eventId, code_hash: hashCode(body.code), starts_at: body.startsAt, expires_at: body.expiresAt, created_by: request.principal!.profileId }).select("id,event_id,starts_at,expires_at,is_active").single());
    await audit(request.principal!.profileId, "event.checkin_code_created", "event", eventId); return reply.code(201).send(row);
  });

  app.post("/api/v1/admin/events/:eventId/attendance", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const body = z.object({ profileId: z.string().uuid(), attended: z.boolean() }).parse(request.body);
    unwrap(await db().from("event_registrations").upsert({ event_id: eventId, profile_id: body.profileId, status: body.attended ? "attended" : "no_show", source: "admin", updated_at: new Date().toISOString() }, { onConflict: "event_id,profile_id" }));
    await audit(request.principal!.profileId, "event.attendance", "event", eventId, body); return { ok: true };
  });
}
