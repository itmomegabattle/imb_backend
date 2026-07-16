import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireRole } from "../../lib/session.js";

const adminOnly = requireRole(...adminRoles);

export async function operationsRoutes(app: FastifyInstance) {
  app.post("/api/v1/admin/seasons", { preHandler: adminOnly }, async (request, reply) => {
    const body = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,60}$/), title: z.string().min(2).max(120), startsAt: z.string().datetime(), endsAt: z.string().datetime() }).parse(request.body);
    const result = await db().rpc("start_new_season", { p_slug: body.slug, p_title: body.title, p_starts_at: body.startsAt, p_ends_at: body.endsAt });
    if (result.error) return reply.code(409).send({ error: result.error.message });
    await audit(request.principal!.profileId, "season.started", "season", (result.data as any)?.id, { slug: body.slug, title: body.title });
    return reply.code(201).send(result.data);
  });

  app.get("/api/v1/info", async () => ({
    sections: unwrap(await db().from("info_sections").select("key,title,body,sort_order,updated_at").eq("is_published", true).order("sort_order")) ?? [],
  }));

  app.put("/api/v1/admin/info/:key", { preHandler: adminOnly }, async (request) => {
    const key = z.string().regex(/^[a-z0-9_-]{2,40}$/).parse((request.params as { key: string }).key);
    const body = z.object({ title: z.string().min(2).max(120), body: z.string().min(1).max(12000), sortOrder: z.number().int().min(0).max(10000).default(100), isPublished: z.boolean().default(true) }).parse(request.body);
    const row = unwrap(await db().from("info_sections").upsert({ key, title: body.title, body: body.body, sort_order: body.sortOrder, is_published: body.isPublished, updated_by: request.principal!.profileId, updated_at: new Date().toISOString() }).select("*").single());
    await audit(request.principal!.profileId, "info.updated", "info_section", key, { title: body.title });
    return row;
  });

  app.get("/api/v1/admin/game/achievements", { preHandler: adminOnly }, async () => ({
    achievements: unwrap(await db().from("achievements").select("*").order("name")) ?? [],
  }));

  app.post("/api/v1/admin/game/achievements", { preHandler: adminOnly }, async (request, reply) => {
    const body = z.object({ code: z.string().regex(/^[a-z0-9_-]{2,80}$/), name: z.string().min(2).max(120), description: z.string().max(1000).nullable().optional(), iconUrl: z.string().url().nullable().optional(), maxAmount: z.number().int().positive().nullable().optional(), hidden: z.boolean().default(false) }).parse(request.body);
    const row = unwrap(await db().from("achievements").upsert({ code: body.code, name: body.name, description: body.description, icon_url: body.iconUrl, max_amount: body.maxAmount, is_hidden: body.hidden }, { onConflict: "code" }).select("*").single());
    await audit(request.principal!.profileId, "achievement.saved", "achievement", row?.id, { code: body.code });
    return reply.code(201).send(row);
  });

  app.get("/api/v1/admin/stats", { preHandler: adminOnly }, async () => {
    const season = unwrap(await db().from("seasons").select("id,title").eq("is_active", true).single());
    if (!season) throw Object.assign(new Error("Активный сезон не найден"), { statusCode: 503 });
    const [profiles, registrations, attendance, currency, faculties] = await Promise.all([
      db().from("profiles").select("id", { count: "exact", head: true }).eq("onboarding_completed", true).eq("is_banned", false).is("deleted_at", null),
      db().from("event_registrations").select("id", { count: "exact", head: true }).neq("status", "cancelled"),
      db().from("event_registrations").select("id", { count: "exact", head: true }).eq("status", "attended"),
      db().from("currency_transactions").select("amount").eq("season_id", season.id).gt("amount", 0),
      db().from("current_faculty_balances").select("faculty,balance").order("balance", { ascending: false }),
    ]);
    for (const value of [profiles, registrations, attendance, currency, faculties]) if (value.error) throw value.error;
    return { season, users: profiles.count ?? 0, registrations: registrations.count ?? 0, attendances: attendance.count ?? 0, issuedCurrency: (currency.data ?? []).reduce((sum, row) => sum + Number(row.amount), 0), faculties: faculties.data ?? [] };
  });

  app.post("/api/v1/admin/broadcasts", { preHandler: adminOnly }, async (request, reply) => {
    const body = z.object({ text: z.string().min(1).max(4000), mediaFileId: z.string().max(500).nullable().optional(), idempotencyKey: z.string().min(12).max(200).optional() }).parse(request.body);
    const idempotencyKey = body.idempotencyKey ?? randomBytes(18).toString("hex");
    const existing = unwrap(await db().from("broadcasts").select("*").eq("idempotency_key", idempotencyKey).maybeSingle());
    if (existing) return reply.code(202).send(existing);
    const recipients = unwrap(await db().from("account_identities").select("profile_id,profiles!inner(onboarding_completed,is_banned,deleted_at)").eq("provider", "telegram")) ?? [];
    const profileIds = [...new Set(recipients.filter((row: any) => {
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return profile?.onboarding_completed && !profile?.is_banned && !profile?.deleted_at;
    }).map((row: any) => row.profile_id))];
    let broadcast = unwrap(await db().from("broadcasts").upsert({ created_by: request.principal!.profileId, text: body.text, media_file_id: body.mediaFileId ?? null, status: "queued", total_count: profileIds.length, idempotency_key: idempotencyKey }, { onConflict: "idempotency_key", ignoreDuplicates: true }).select("*").maybeSingle());
    if (!broadcast) {
      broadcast = unwrap(await db().from("broadcasts").select("*").eq("idempotency_key", idempotencyKey).single());
      return reply.code(202).send(broadcast);
    }
    for (let offset = 0; offset < profileIds.length; offset += 250) {
      const rows = profileIds.slice(offset, offset + 250).map((profileId) => ({ profile_id: profileId, bot: "participant", type: "broadcast", broadcast_id: broadcast.id, payload: { text: body.text, mediaFileId: body.mediaFileId ?? null }, idempotency_key: `broadcast:${broadcast.id}:${profileId}` }));
      unwrap(await db().from("notification_queue").insert(rows));
    }
    await audit(request.principal!.profileId, "broadcast.queued", "broadcast", broadcast.id, { recipients: profileIds.length });
    return reply.code(202).send(broadcast);
  });

  app.get("/api/v1/admin/broadcasts", { preHandler: adminOnly }, async () => ({
    broadcasts: unwrap(await db().from("broadcasts").select("*").order("created_at", { ascending: false }).limit(20)) ?? [],
  }));
}
