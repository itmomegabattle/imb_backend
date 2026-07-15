import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireService } from "../../lib/service-auth.js";
import { TelegramInitDataError, verifyTelegramInitData } from "../../lib/telegram-init-data.js";
import { requireSupabaseAdmin } from "../../lib/supabase.js";

const telegramUserSchema = z.object({
  telegramId: z.number().int().positive(),
  username: z.string().max(64).nullable().optional(),
  firstName: z.string().min(1).max(128),
  lastName: z.string().max(128).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
});

const miniAppSchema = z.object({ initData: z.string().min(1) });
const registrationSchema = z.object({ telegramId: z.number().int().positive() });

async function upsertTelegramUser(input: z.infer<typeof telegramUserSchema>) {
  const supabase = requireSupabaseAdmin();
  const { data, error } = await supabase.rpc("upsert_telegram_identity", {
    p_telegram_user_id: input.telegramId,
    p_username: input.username ?? null,
    p_first_name: input.firstName,
    p_last_name: input.lastName ?? null,
    p_photo_url: input.photoUrl ?? null,
  });
  if (error) throw error;
  return data;
}

async function dashboard(telegramId: number) {
  const supabase = requireSupabaseAdmin();
  const { data, error } = await supabase.rpc("participant_dashboard", { p_telegram_user_id: telegramId });
  if (error) throw error;
  if (!data) throw new Error("Participant profile not found");
  return data;
}

export async function participantRoutes(app: FastifyInstance) {
  app.post("/bot/users/upsert", { preHandler: requireService("participant_bot", "org_bot") }, async (request, reply) => {
    const parsed = telegramUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Telegram user", details: parsed.error.flatten() });
    return upsertTelegramUser(parsed.data);
  });

  app.get("/bot/users/:telegramId/dashboard", { preHandler: requireService("participant_bot", "org_bot") }, async (request, reply) => {
    const telegramId = Number((request.params as { telegramId: string }).telegramId);
    if (!Number.isSafeInteger(telegramId)) return reply.code(400).send({ error: "Invalid Telegram ID" });
    return dashboard(telegramId);
  });

  app.post("/mini-app/session", async (request, reply) => {
    if (!env.TELEGRAM_PARTICIPANT_BOT_TOKEN) return reply.code(503).send({ error: "Participant bot is not configured" });
    const parsed = miniAppSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "initData is required" });
    try {
      const verified = verifyTelegramInitData(
        parsed.data.initData,
        env.TELEGRAM_PARTICIPANT_BOT_TOKEN,
        env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      );
      await upsertTelegramUser({
        telegramId: verified.user.id,
        username: verified.user.username ?? null,
        firstName: verified.user.first_name,
        lastName: verified.user.last_name ?? null,
        photoUrl: verified.user.photo_url ?? null,
      });
      return dashboard(verified.user.id);
    } catch (error) {
      if (error instanceof TelegramInitDataError) return reply.code(401).send({ error: error.message });
      throw error;
    }
  });

  app.get("/leaderboard", async (request, reply) => {
    const limit = Math.min(Math.max(Number((request.query as { limit?: string }).limit ?? 20), 1), 100);
    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase.rpc("participant_leaderboard", { p_limit: limit });
    if (error) return reply.code(500).send({ error: error.message });
    return { leaderboard: data ?? [] };
  });

  app.get("/events", async (_request, reply) => {
    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase
      .from("project_events")
      .select("id, slug, name, type, description, starts_at, ends_at, location, image_url, registration_status, registration_link")
      .eq("status", "published")
      .eq("group_key", "megabattle")
      .order("starts_at", { ascending: true, nullsFirst: false });
    if (error) return reply.code(500).send({ error: error.message });
    return { events: data ?? [] };
  });

  app.post("/events/:eventId/registrations", { preHandler: requireService("participant_bot") }, async (request, reply) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid registration" });
    const eventId = (request.params as { eventId: string }).eventId;
    const supabase = requireSupabaseAdmin();
    const { data: identity, error: identityError } = await supabase
      .from("account_identities")
      .select("profile_id")
      .eq("provider", "telegram")
      .eq("provider_subject", String(parsed.data.telegramId))
      .maybeSingle();
    if (identityError) throw identityError;
    if (!identity) return reply.code(404).send({ error: "Participant not found" });
    const registration = await supabase.rpc("register_for_event", { p_profile_id: identity.profile_id, p_event_id: eventId, p_source: "participant_bot" });
    if (registration.error) {
      if (registration.error.message.includes("ITMO_ID_REQUIRED")) return reply.code(428).send({ error: "Для регистрации привяжите ITMO.ID", code: "ITMO_ID_REQUIRED" });
      return reply.code(409).send({ error: "Регистрация закрыта", details: registration.error.message });
    }
    return reply.code(201).send(registration.data);
  });

  app.delete("/events/:eventId/registrations/:telegramId", { preHandler: requireService("participant_bot") }, async (request, reply) => {
    const { eventId, telegramId: rawTelegramId } = request.params as { eventId: string; telegramId: string };
    const telegramId = Number(rawTelegramId);
    const supabase = requireSupabaseAdmin();
    const { data: identity } = await supabase
      .from("account_identities")
      .select("profile_id")
      .eq("provider", "telegram")
      .eq("provider_subject", String(telegramId))
      .maybeSingle();
    if (!identity) return reply.code(404).send({ error: "Participant not found" });
    const { error } = await supabase
      .from("event_registrations")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .eq("profile_id", identity.profile_id);
    if (error) throw error;
    return { ok: true };
  });
}
