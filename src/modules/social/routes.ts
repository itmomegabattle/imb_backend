import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, optionalSession, requireOnboardedSession, requireRole, requireSession } from "../../lib/session.js";

const tagType = z.enum(["keychain", "card", "removable", "sticker", "other"]);
const publicProfile = "id,nickname,full_name,faculty,bio,avatar_url,telegram_username,instagram_username,social_links,role_badge,is_best_actor";

function generateTagCode() { return randomBytes(24).toString("base64url"); }

export async function socialRoutes(app: FastifyInstance) {
  app.get("/api/v1/nfc/:code", { preHandler: optionalSession }, async (request, reply) => {
    const parsedCode = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).safeParse((request.params as { code: string }).code);
    if (!parsedCode.success) return reply.code(404).send({ error: "Метка не найдена" });
    const code = parsedCode.data;
    const tag = unwrap(await db().from("nfc_tags").select(`id,label,tag_type,is_active,profile_id,scan_count,profiles(${publicProfile})`).or(`code.eq.${code},public_slug.eq.${code}`).maybeSingle());
    if (!tag || !tag.is_active || !tag.profile_id) return reply.code(404).send({ error: "Метка не найдена или ещё не привязана" });
    unwrap(await db().rpc("increment_nfc_scan", { p_tag_id: tag.id }));
    unwrap(await db().from("profile_views").insert({ viewer_profile_id: request.principal?.profileId ?? null, viewed_profile_id: tag.profile_id, nfc_tag_id: tag.id }));
    return { tag: { id: tag.id, label: tag.label, type: tag.tag_type }, profile: tag.profiles, canConnect: Boolean(request.principal && request.principal.profileId !== tag.profile_id) };
  });

  app.get("/api/v1/nfc", { preHandler: requireSession }, async (request) => {
    const tags = unwrap(await db().from("nfc_tags").select("id,code,public_slug,label,tag_type,is_active,claimed_at,last_scanned_at,scan_count").eq("profile_id", request.principal!.profileId).order("created_at"));
    return { tags };
  });

  app.post("/api/v1/nfc/:code/claim", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const parsedCode = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).safeParse((request.params as { code: string }).code);
    if (!parsedCode.success) return reply.code(404).send({ error: "Метка не найдена" });
    const code = parsedCode.data;
    const tag = unwrap(await db().from("nfc_tags").select("id,profile_id,is_active").or(`code.eq.${code},public_slug.eq.${code}`).maybeSingle());
    if (!tag || !tag.is_active) return reply.code(404).send({ error: "Метка не найдена" });
    if (tag.profile_id && tag.profile_id !== request.principal!.profileId) return reply.code(409).send({ error: "Метка уже привязана" });
    const body = z.object({ label: z.string().max(80).optional(), tagType: tagType.optional() }).parse(request.body ?? {});
    const result = unwrap(await db().from("nfc_tags").update({ profile_id: request.principal!.profileId, label: body.label, tag_type: body.tagType, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", tag.id).select("*").single());
    await audit(request.principal!.profileId, "nfc.claimed", "nfc_tag", tag.id);
    return result;
  });

  app.delete("/api/v1/nfc/:id/claim", { preHandler: requireSession }, async (request) => {
    const id = (request.params as { id: string }).id;
    unwrap(await db().from("nfc_tags").update({ profile_id: null, claimed_at: null, updated_at: new Date().toISOString() }).eq("id", id).eq("profile_id", request.principal!.profileId));
    await audit(request.principal!.profileId, "nfc.unclaimed", "nfc_tag", id); return { ok: true };
  });

  app.post("/api/v1/connections", { preHandler: requireOnboardedSession }, async (request, reply) => {
    const body = z.object({ profileId: z.string().uuid(), nfcTagId: z.string().uuid().optional() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Некорректный профиль" });
    if (body.data.profileId === request.principal!.profileId) return reply.code(409).send({ error: "Нельзя добавить самого себя" });
    const [requester_profile_id, receiver_profile_id] = [request.principal!.profileId, body.data.profileId].sort();
    const result = unwrap(await db().from("friendships").upsert({ requester_profile_id, receiver_profile_id, status: "active", source: body.data.nfcTagId ? "nfc" : "profile", nfc_tag_id: body.data.nfcTagId ?? null, updated_at: new Date().toISOString() }, { onConflict: "requester_profile_id,receiver_profile_id" }).select("*").single());
    await audit(request.principal!.profileId, "connection.created", "friendship", result.id, { target: body.data.profileId });
    return reply.code(201).send(result);
  });

  app.delete("/api/v1/connections/:profileId", { preHandler: requireSession }, async (request) => {
    const target = (request.params as { profileId: string }).profileId;
    const [a, b] = [request.principal!.profileId, target].sort();
    unwrap(await db().from("friendships").update({ status: "hidden", updated_at: new Date().toISOString() }).eq("requester_profile_id", a).eq("receiver_profile_id", b));
    await audit(request.principal!.profileId, "connection.hidden", "profile", target); return { ok: true };
  });

  app.get("/api/v1/connections/graph", async (request) => {
    const q = z.object({ limit: z.coerce.number().int().min(10).max(3000).default(500), focus: z.string().uuid().optional() }).parse(request.query);
    let edgesQuery = db().from("friendships").select("id,requester_profile_id,receiver_profile_id,created_at").eq("status", "active").limit(q.limit * 4);
    if (q.focus) edgesQuery = edgesQuery.or(`requester_profile_id.eq.${q.focus},receiver_profile_id.eq.${q.focus}`);
    const edges = unwrap(await edgesQuery) ?? [];
    const ids = [...new Set(edges.flatMap((edge) => [edge.requester_profile_id, edge.receiver_profile_id]))].slice(0, q.limit);
    const nodes = ids.length ? unwrap(await db().from("profiles").select("id,nickname,full_name,faculty,avatar_url,role_badge").in("id", ids).eq("is_banned", false).is("deleted_at", null)) ?? [] : [];
    const allowed = new Set(nodes.map((node) => node.id));
    return { nodes, edges: edges.filter((edge) => allowed.has(edge.requester_profile_id) && allowed.has(edge.receiver_profile_id)) };
  });

  app.get("/api/v1/admin/nfc", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const q = z.object({ search: z.string().optional(), limit: z.coerce.number().min(1).max(200).default(100) }).parse(request.query);
    let query = db().from("nfc_tags").select("*,profiles(id,nickname,full_name,isu_number)").limit(q.limit).order("created_at", { ascending: false });
    if (q.search) { const safe = q.search.replace(/[%_,]/g, ""); query = query.or(`code.ilike.%${safe}%,label.ilike.%${safe}%,public_slug.ilike.%${safe}%`); }
    return { tags: unwrap(await query) };
  });

  app.post("/api/v1/admin/nfc", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const body = z.object({ count: z.number().int().min(1).max(500).default(1), tagType: tagType.default("other"), labelPrefix: z.string().max(50).default("Метка") }).parse(request.body);
    const tags = Array.from({ length: body.count }, (_, index) => ({ code: generateTagCode(), public_slug: randomBytes(8).toString("hex"), tag_type: body.tagType, label: `${body.labelPrefix} ${index + 1}` }));
    const data = unwrap(await db().from("nfc_tags").insert(tags).select("*"));
    await audit(request.principal!.profileId, "nfc.generated", "nfc_tag", undefined, { count: data?.length ?? 0, type: body.tagType });
    return reply.code(201).send({ tags: data });
  });

  app.patch("/api/v1/admin/nfc/:id", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const body = z.object({ label: z.string().max(80).nullable().optional(), tag_type: tagType.optional(), is_active: z.boolean().optional(), profile_id: z.string().uuid().nullable().optional() }).parse(request.body);
    const patch: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() };
    if (Object.hasOwn(body, "profile_id")) patch.claimed_at = body.profile_id ? new Date().toISOString() : null;
    const row = unwrap(await db().from("nfc_tags").update(patch).eq("id", id).select("*,profiles(id,nickname,isu_number,faculty,is_banned)").single());
    await audit(request.principal!.profileId, "nfc.updated", "nfc_tag", id, body);
    return row;
  });
}
