import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, unwrap } from "../../lib/db.js";
import { requireRole } from "../../lib/session.js";

const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "application/pdf"]);
const extensionByMime: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf" };
const adminOnly = requireRole("admin", "site_admin");

export async function supportRoutes(app: FastifyInstance) {
  app.post("/api/v1/support/upload", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = z.object({ mimeType: z.string(), sizeBytes: z.number().int().positive().max(20 * 1024 * 1024) }).parse(request.body);
    if (!allowedMime.has(body.mimeType)) return reply.code(400).send({ error: "Можно прикрепить изображение, видео или PDF" });
    const path = `support/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${randomBytes(10).toString("hex")}.${extensionByMime[body.mimeType]}`;
    const signed = unwrap(await db().storage.from("support-media").createSignedUploadUrl(path));
    return reply.code(201).send({ ...signed, bucket: "support-media", path });
  });

  app.post("/api/v1/support", { config: { rateLimit: { max: 8, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = z.object({
      contact: z.string().trim().min(3).max(200),
      message: z.string().trim().min(10).max(5000),
      attachmentPath: z.string().regex(/^support\/[\w./-]+$/).nullable().optional(),
      attachmentName: z.string().trim().max(240).nullable().optional(),
      attachmentMime: z.string().max(100).nullable().optional(),
      consent: z.literal(true),
    }).parse(request.body);
    const row = unwrap(await db().from("support_requests").insert({
      contact: body.contact,
      message: body.message,
      attachment_path: body.attachmentPath ?? null,
      attachment_name: body.attachmentName ?? null,
      attachment_mime: body.attachmentMime ?? null,
      user_agent: String(request.headers["user-agent"] || "").slice(0, 500),
    }).select("id,created_at").single());
    return reply.code(201).send(row);
  });

  app.get("/api/v1/admin/support", { preHandler: adminOnly }, async () => ({
    items: unwrap(await db().from("support_requests").select("*").order("created_at", { ascending: false }).limit(100)) ?? [],
  }));

  app.get("/api/v1/admin/support/:id/attachment", { preHandler: adminOnly }, async (request, reply) => {
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const row = unwrap(await db().from("support_requests").select("attachment_path").eq("id", id).maybeSingle());
    if (!row?.attachment_path) return reply.code(404).send({ error: "Вложение не найдено" });
    const signed = unwrap(await db().storage.from("support-media").createSignedUrl(row.attachment_path, 300));
    if (!signed) return reply.code(404).send({ error: "Вложение не найдено" });
    return { url: signed.signedUrl };
  });

  app.patch("/api/v1/admin/support/:id", { preHandler: adminOnly }, async (request) => {
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const body = z.object({ status: z.enum(["new", "in_progress", "resolved"]) }).parse(request.body);
    return unwrap(await db().from("support_requests").update({ status: body.status, updated_at: new Date().toISOString() }).eq("id", id).select("*").single());
  });
}
