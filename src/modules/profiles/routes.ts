import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireRole, requireSession } from "../../lib/session.js";

const profilePatch = z.object({
  nickname: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}_. -]+$/u, "Недопустимые символы в никнейме").optional(),
  full_name: z.string().trim().max(120).nullable().optional(),
  isu_number: z.string().trim().max(12).nullable().optional(),
  faculty: z.enum(["КТУ", "ТИНТ", "НОЖ", "ФТМФ", "ФТМИ"]).nullable().optional(),
  bio: z.string().trim().max(600).nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
  telegram_username: z.string().trim().max(64).nullable().optional(),
  instagram_username: z.string().trim().max(64).nullable().optional(),
  social_links: z.array(z.object({ label: z.string().max(30), url: z.string().url(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() })).max(3).optional(),
  birth_date: z.string().date().nullable().optional(),
  onboarding_completed: z.boolean().optional(),
});

const publicFields = "id,nickname,full_name,faculty,bio,avatar_url,telegram_username,instagram_username,social_links,megaballs,role_badge,is_best_actor,is_banned,created_at";

export async function profileRoutes(app: FastifyInstance) {
  app.get("/api/v1/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = db().from("profiles").select(publicFields).is("deleted_at", null).eq(z.string().uuid().safeParse(id).success ? "id" : "nickname", id);
    const data = unwrap(await query.maybeSingle());
    if (!data || data.is_banned) return reply.code(404).send({ error: "Профиль не найден" });
    const { is_banned: _isBanned, ...publicData } = data;
    return publicData;
  });

  app.get("/api/v1/profile", { preHandler: requireSession }, async (request) => {
    const profile = unwrap(await db().from("profiles").select("*").eq("id", request.principal!.profileId).single());
    const identities = unwrap(await db().from("account_identities").select("provider,provider_subject,username,verified_at").eq("profile_id", request.principal!.profileId));
    return { profile, identities, roles: request.principal!.roles };
  });

  app.patch("/api/v1/profile", { preHandler: requireSession }, async (request, reply) => {
    const parsed = profilePatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректный профиль", details: parsed.error.flatten() });
    const current = unwrap(await db().from("profiles").select("nickname,faculty").eq("id", request.principal!.profileId).single());
    if (!current) return reply.code(404).send({ error: "Профиль не найден" });
    const nickname = parsed.data.nickname ?? current.nickname;
    const faculty = parsed.data.faculty === undefined ? current.faculty : parsed.data.faculty;
    const result = await db().from("profiles").update({ ...parsed.data, onboarding_completed: Boolean(nickname && faculty), updated_at: new Date().toISOString() }).eq("id", request.principal!.profileId).select("*").single();
    if (result.error?.code === "23505") return reply.code(409).send({ error: "Этот никнейм уже занят" });
    if (result.error) throw result.error;
    const data = result.data;
    await audit(request.principal!.profileId, "profile.updated", "profile", request.principal!.profileId, { fields: Object.keys(parsed.data) });
    return data;
  });

  app.get("/api/v1/admin/profiles", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const q = z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(10), offset: z.coerce.number().int().min(0).default(0), includeDeleted: z.coerce.boolean().default(false) }).parse(request.query);
    let query = db().from("profiles").select("*,profile_roles(role),account_identities(provider,provider_subject,username)", { count: "exact" }).order("nickname").range(q.offset, q.offset + q.limit - 1);
    if (!q.includeDeleted) query = query.is("deleted_at", null);
    if (q.search) query = query.or(`nickname.ilike.%${q.search.replace(/[%_,]/g, "")}%,isu_number.ilike.%${q.search.replace(/[%_,]/g, "")}%,full_name.ilike.%${q.search.replace(/[%_,]/g, "")}%`);
    const result = await query;
    if (result.error) throw result.error;
    return { items: result.data ?? [], total: result.count ?? 0, limit: q.limit, offset: q.offset };
  });

  app.patch("/api/v1/admin/profiles/:id/moderation", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const body = z.object({ is_banned: z.boolean().optional(), ban_reason: z.string().max(500).nullable().optional(), role_badge: z.string().max(80).nullable().optional(), is_best_actor: z.boolean().optional() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Некорректные данные" });
    const id = (request.params as { id: string }).id;
    const data = unwrap(await db().from("profiles").update({ ...body.data, updated_at: new Date().toISOString() }).eq("id", id).select("*").single());
    await audit(request.principal!.profileId, "profile.moderated", "profile", id, body.data);
    return data;
  });

  app.put("/api/v1/admin/profiles/:id/roles/:role", { preHandler: requireRole("admin", "site_admin") }, async (request, reply) => {
    const { id, role } = request.params as { id: string; role: string };
    const parsed = z.enum(["participant", "admin", "site_admin"]).safeParse(role);
    if (!parsed.success) return reply.code(400).send({ error: "Неизвестная роль" });
    unwrap(await db().from("profile_roles").upsert({ profile_id: id, role: parsed.data, granted_by: request.principal!.profileId }, { onConflict: "profile_id,role" }));
    await audit(request.principal!.profileId, "role.granted", "profile", id, { role: parsed.data });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/v1/admin/profiles/:id/roles/:role", { preHandler: requireRole("admin", "site_admin") }, async (request, reply) => {
    const { id, role } = request.params as { id: string; role: string };
    if (id === request.principal!.profileId && ["admin", "site_admin"].includes(role)) return reply.code(409).send({ error: "Нельзя снять собственную административную роль" });
    unwrap(await db().from("profile_roles").delete().eq("profile_id", id).eq("role", role));
    await audit(request.principal!.profileId, "role.revoked", "profile", id, { role });
    return { ok: true };
  });

  app.delete("/api/v1/admin/profiles/:id", { preHandler: requireRole("admin", "site_admin") }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (id === request.principal!.profileId) return reply.code(409).send({ error: "Нельзя удалить собственный профиль" });
    unwrap(await db().from("profiles").update({ deleted_at: new Date().toISOString(), is_banned: true, ban_reason: "Удалён администратором" }).eq("id", id));
    await audit(request.principal!.profileId, "profile.deleted", "profile", id);
    return reply.code(204).send();
  });
}
