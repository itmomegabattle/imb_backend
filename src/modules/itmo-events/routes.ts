import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireRole } from "../../lib/session.js";

async function itmoRequest(path: string, init?: RequestInit) {
  if (!env.ITMO_EVENTS_BASE_URL || !env.ITMO_EVENTS_API_KEY) throw Object.assign(new Error("ITMO Events API не настроен"), { statusCode: 503 });
  const response = await fetch(`${env.ITMO_EVENTS_BASE_URL.replace(/\/$/, "")}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ITMO_EVENTS_API_KEY}`, ...init?.headers } });
  const body = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(`ITMO Events API: ${response.status}`), { statusCode: 502, details: body }); return body;
}

export async function itmoEventsRoutes(app: FastifyInstance) {
  app.post("/api/v1/integrations/itmo-events/events/:eventId/publish", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const event = unwrap(await db().from("project_events").select("*").eq("id", eventId).single());
    if (!event) throw new Error("Событие не найдено");
    const external = await itmoRequest("/events", { method: "POST", body: JSON.stringify({ title: event.name, description: event.description, startsAt: event.starts_at, endsAt: event.ends_at, location: event.location, capacity: event.capacity }) }) as any;
    unwrap(await db().from("project_events").update({ itmo_events_id: external.id, updated_at: new Date().toISOString() }).eq("id", eventId));
    await audit(request.principal!.profileId, "itmo_events.published", "event", eventId, { externalId: external.id }); return external;
  });

  app.post("/api/v1/integrations/itmo-events/events/:eventId/sync", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const eventId = (request.params as { eventId: string }).eventId;
    const event = unwrap(await db().from("project_events").select("itmo_events_id").eq("id", eventId).single());
    if (!event?.itmo_events_id) throw Object.assign(new Error("Событие не связано с ITMO Events"), { statusCode: 409 });
    const registrations = await itmoRequest(`/events/${encodeURIComponent(event.itmo_events_id)}/registrations`) as any;
    let synced = 0;
    for (const item of registrations.items ?? registrations ?? []) {
      if (!item.isu) continue;
      const profile = unwrap(await db().from("profiles").select("id").eq("isu_number", String(item.isu)).maybeSingle()); if (!profile) continue;
      unwrap(await db().from("event_registrations").upsert({ event_id: eventId, profile_id: profile.id, status: item.attended ? "attended" : "registered", source: "itmo_events", itmo_events_registration_id: String(item.id), updated_at: new Date().toISOString() }, { onConflict: "event_id,profile_id" })); synced++;
    }
    await audit(request.principal!.profileId, "itmo_events.synced", "event", eventId, { synced }); return { ok: true, synced };
  });

  app.post("/webhooks/itmo-events", async (request, reply) => {
    const secret = request.headers["x-webhook-secret"];
    if (!env.ITMO_EVENTS_WEBHOOK_SECRET || secret !== env.ITMO_EVENTS_WEBHOOK_SECRET) return reply.code(401).send({ error: "Invalid webhook secret" });
    const body = z.object({ type: z.string(), registration: z.object({ id: z.union([z.string(), z.number()]), eventId: z.union([z.string(), z.number()]), isu: z.union([z.string(), z.number()]), attended: z.boolean().optional() }) }).parse(request.body);
    const event = unwrap(await db().from("project_events").select("id").eq("itmo_events_id", String(body.registration.eventId)).maybeSingle());
    const profile = unwrap(await db().from("profiles").select("id").eq("isu_number", String(body.registration.isu)).maybeSingle());
    if (event && profile) unwrap(await db().from("event_registrations").upsert({ event_id: event.id, profile_id: profile.id, status: body.registration.attended ? "attended" : "registered", source: "itmo_events", itmo_events_registration_id: String(body.registration.id), updated_at: new Date().toISOString() }, { onConflict: "event_id,profile_id" }));
    return { ok: true };
  });
}
