import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db } from "../../lib/db.js";
import { adminRoles, requireRole } from "../../lib/session.js";
import { requireSession } from "../../lib/session.js";

const resources = {
  people: { table: "team_members", order: "sort_order" },
  stories: { table: "participant_stories", order: "sort_order" },
  partners: { table: "partners", order: "sort_order" },
  events: { table: "project_events", order: "sort_order" },
} as const;
type Resource = keyof typeof resources;

function config(raw: string) {
  if (!(raw in resources)) throw Object.assign(new Error("Неизвестный раздел"), { statusCode: 404 });
  return resources[raw as Resource];
}

export async function contentRoutes(app: FastifyInstance) {
  app.post("/api/v1/stories/submissions", { preHandler: requireSession }, async (request, reply) => {
    const parsed = z.object({ name: z.string().min(2).max(120), faculty: z.string().max(100).nullable().optional(), description: z.string().min(20).max(5000), storyDateLabel: z.string().max(100).nullable().optional(), imageUrl: z.string().url().nullable().optional(), contact: z.string().max(200).nullable().optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Проверьте поля истории", details: parsed.error.flatten() });
    const item = await db().from("participant_stories").insert({ status: "pending", name: parsed.data.name, faculty: parsed.data.faculty, description: parsed.data.description, story_date_label: parsed.data.storyDateLabel, image_url: parsed.data.imageUrl, submitter_contact: parsed.data.contact, submitter_profile_id: request.principal!.profileId }).select("*").single();
    if (item.error) throw item.error;
    await audit(request.principal!.profileId, "story.submitted", "story", item.data.id);
    return reply.code(201).send(item.data);
  });

  app.get("/api/v1/stories/submissions/mine", { preHandler: requireSession }, async (request) => {
    const result = await db().from("participant_stories").select("*").eq("submitter_profile_id", request.principal!.profileId).order("created_at", { ascending: false });
    if (result.error) throw result.error; return { items: result.data ?? [] };
  });

  app.post("/api/v1/admin/stories/:id/moderate", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const id = (request.params as { id: string }).id;
    const body = z.object({ decision: z.enum(["published", "rejected", "draft"]), comment: z.string().max(1000).nullable().optional() }).parse(request.body);
    const result = await db().from("participant_stories").update({ status: body.decision, moderation_comment: body.comment, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
    if (result.error) throw result.error; await audit(request.principal!.profileId, `story.${body.decision}`, "story", id); return result.data;
  });

  app.get("/api/v1/content/:resource", async (request) => {
    const { resource } = request.params as { resource: string }; const meta = config(resource);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const builder = db().from(meta.table).select("*").limit(query.limit).eq("status", "published");
    const result = await builder.order(meta.order, { ascending: true, nullsFirst: false });
    if (result.error) throw result.error;
    return { items: result.data ?? [] };
  });

  app.get("/api/v1/admin/content/:resource", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const { resource } = request.params as { resource: string }; const meta = config(resource);
    const result = await db().from(meta.table).select("*").order(meta.order, { ascending: true, nullsFirst: false });
    if (result.error) throw result.error; return { items: result.data ?? [] };
  });

  app.post("/api/v1/admin/content/:resource", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const { resource } = request.params as { resource: string }; const meta = config(resource);
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    delete body.id; delete body.created_at; delete body.updated_at;
    const result = await db().from(meta.table).insert(body).select("*").single();
    if (result.error) throw result.error;
    await audit(request.principal!.profileId, "content.created", resource, result.data.id, body);
    return reply.code(201).send(result.data);
  });

  app.patch("/api/v1/admin/content/:resource/:id", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const { resource, id } = request.params as { resource: string; id: string }; const meta = config(resource);
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    delete body.id; delete body.created_at;
    const result = await db().from(meta.table).update({ ...body, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
    if (result.error) throw result.error;
    await audit(request.principal!.profileId, "content.updated", resource, id, { fields: Object.keys(body) });
    return result.data;
  });

  app.delete("/api/v1/admin/content/:resource/:id", { preHandler: requireRole(...adminRoles) }, async (request, reply) => {
    const { resource, id } = request.params as { resource: string; id: string }; const meta = config(resource);
    const result = await db().from(meta.table).delete().eq("id", id); if (result.error) throw result.error;
    await audit(request.principal!.profileId, "content.deleted", resource, id);
    return reply.code(204).send();
  });
}
