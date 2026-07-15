import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireRole, requireSession } from "../../lib/session.js";

const hashCode = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");

async function dashboard(profileId: string) {
  const profile = unwrap(await db().from("profiles").select("id,nickname,full_name,faculty,avatar_url,role_badge").eq("id", profileId).single());
  const [scores, currencies, achievements, registrations] = await Promise.all([
    db().from("score_transactions").select("id,amount,reason,source,created_at").eq("profile_id", profileId).order("created_at", { ascending: false }),
    db().from("currency_transactions").select("amount,currencies(code,name,icon_url)").eq("profile_id", profileId),
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
  return { profile, level: { ...level, xp, next, percent: next ? Math.round(100 * (xp - level.min_xp) / Math.max(1, next.min_xp - level.min_xp)) : 100 }, rank, balances: [...balances.values()], achievements: achievements.data ?? [], registrations: registrations.data ?? [], history: (scores.data ?? []).slice(0, 20) };
}

export async function gameRoutes(app: FastifyInstance) {
  app.get("/api/v1/game/dashboard", { preHandler: requireSession }, (request) => dashboard(request.principal!.profileId));

  app.get("/api/v1/game/leaderboard", async (request) => {
    const limit = z.coerce.number().int().min(1).max(3000).default(100).parse((request.query as any).limit);
    const participants = unwrap(await db().rpc("participant_leaderboard", { p_limit: limit }));
    const facultyScores = await db().from("score_transactions").select("amount,profiles!inner(faculty,is_banned,deleted_at)").eq("profiles.is_banned", false).is("profiles.deleted_at", null);
    if (facultyScores.error) throw facultyScores.error;
    const facultyMap = new Map<string, number>();
    for (const row of facultyScores.data ?? []) {
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles as any;
      if (profile?.faculty) facultyMap.set(profile.faculty, (facultyMap.get(profile.faculty) ?? 0) + Number(row.amount));
    }
    const faculties = [...facultyMap.entries()].sort((a, b) => b[1] - a[1]).map(([faculty, xp], index) => ({ place: index + 1, faculty, xp }));
    return { participants, faculties };
  });

  app.post("/api/v1/game/rewards/redeem", { preHandler: requireSession }, async (request, reply) => {
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
    if (body.data.type === "xp") {
      unwrap(await db().from("score_transactions").insert({ profile_id: body.data.profileId, amount: Math.trunc(body.data.amount), reason: body.data.reason, source: "manual", created_by: request.principal!.profileId, idempotency_key: body.data.idempotencyKey }));
    } else {
      const currency = unwrap(await db().from("currencies").select("id").eq("code", body.data.currencyCode ?? "credits").single());
      if (!currency) throw new Error("Валюта не найдена");
      unwrap(await db().from("currency_transactions").insert({ profile_id: body.data.profileId, currency_id: currency.id, amount: body.data.amount, reason: body.data.reason, source: "manual", created_by: request.principal!.profileId, idempotency_key: body.data.idempotencyKey }));
    }
    await audit(request.principal!.profileId, "game.transaction", "profile", body.data.profileId, body.data);
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/v1/admin/game/reward-codes", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const body = z.object({ code: z.string().min(3).max(100), label: z.string().min(2).max(150), xpAmount: z.number().int().default(0), currencyCode: z.string().optional(), currencyAmount: z.number().optional(), maxRedemptions: z.number().int().positive().optional(), perProfileLimit: z.number().int().positive().default(1), startsAt: z.string().datetime().optional(), expiresAt: z.string().datetime().optional() }).parse(request.body);
    const result = unwrap(await db().from("reward_codes").insert({ code_hash: hashCode(body.code), label: body.label, xp_amount: body.xpAmount, currency_code: body.currencyCode, currency_amount: body.currencyAmount, max_redemptions: body.maxRedemptions, per_profile_limit: body.perProfileLimit, starts_at: body.startsAt, expires_at: body.expiresAt, created_by: request.principal!.profileId }).select("id,label,xp_amount,currency_code,currency_amount,max_redemptions,expires_at,is_active").single());
    if (!result) throw new Error("Не удалось создать код");
    await audit(request.principal!.profileId, "reward.created", "reward_code", result.id, { ...body, code: "[hidden]" });
    return reply.code(201).send(result);
  });

  app.post("/api/v1/events/:eventId/register", { preHandler: requireSession }, async (request, reply) => {
    const eventId = (request.params as { eventId: string }).eventId;
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

  app.post("/api/v1/events/checkin", { preHandler: requireSession }, async (request, reply) => {
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
