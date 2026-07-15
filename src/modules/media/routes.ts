import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireRole, requireSession } from "../../lib/session.js";

const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"]);
const extensionByMime: Record<string,string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };

export async function mediaRoutes(app: FastifyInstance) {
  app.post("/api/v1/media/upload", { preHandler: requireSession }, async (request, reply) => {
    const parsed = z.object({ mimeType: z.string(), sizeBytes: z.number().int().positive().max(100 * 1024 * 1024), purpose: z.enum(["avatar", "story", "content", "temporary"]), temporaryTtlMinutes: z.number().int().min(5).max(1440).optional() }).safeParse(request.body);
    if (!parsed.success || !allowedMime.has(parsed.data?.mimeType ?? "")) return reply.code(400).send({ error: "Неподдерживаемый файл" });
    if (parsed.data.purpose === "content" && !request.principal!.roles.some((role) => adminRoles.includes(role))) return reply.code(403).send({ error: "Недостаточно прав" });
    const temporary = parsed.data.purpose === "temporary"; const bucket = temporary ? "temporary-media" : parsed.data.purpose === "avatar" ? "profile-avatars" : "content-media";
    const path = `${parsed.data.purpose}/${request.principal!.profileId}/${Date.now()}-${randomBytes(8).toString("hex")}.${extensionByMime[parsed.data.mimeType]}`;
    const signed = unwrap(await db().storage.from(bucket).createSignedUploadUrl(path));
    let mediaId: string | undefined;
    if (temporary) {
      const media = unwrap(await db().from("temporary_media").insert({ owner_profile_id: request.principal!.profileId, bucket, object_path: path, mime_type: parsed.data.mimeType, size_bytes: parsed.data.sizeBytes, expires_at: new Date(Date.now() + (parsed.data.temporaryTtlMinutes ?? env.TEMP_MEDIA_TTL_MINUTES) * 60_000).toISOString() }).select("id,expires_at").single());
      if (!media) throw new Error("Не удалось зарегистрировать временный файл");
      mediaId = media.id;
    }
    const publicUrl = temporary ? null : db().storage.from(bucket).getPublicUrl(path).data.publicUrl;
    await audit(request.principal!.profileId, "media.upload_url", "media", mediaId, { purpose: parsed.data.purpose, sizeBytes: parsed.data.sizeBytes });
    return reply.code(201).send({ ...signed, bucket, path, mediaId, publicUrl });
  });

  app.get("/api/v1/media/temporary/:id", { preHandler: requireSession }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const media = unwrap(await db().from("temporary_media").select("*").eq("id", id).is("deleted_at", null).gt("expires_at", new Date().toISOString()).maybeSingle());
    if (!media) return reply.code(404).send({ error: "Фото удалено или срок хранения истёк" });
    const signed = unwrap(await db().storage.from(media.bucket).createSignedUrl(media.object_path, 300)); if (!signed) throw new Error("Не удалось подписать URL"); return { url: signed.signedUrl, expiresIn: 300 };
  });
}
