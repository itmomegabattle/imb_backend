import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { adminRoles, requireRole } from "../../lib/session.js";
import { decryptVault, encryptVault, verifyVaultPin } from "../../lib/vault.js";

const adminOnly = requireRole("admin", "site_admin");
const vaultPayload = z.object({ title: z.string().min(2).max(120), login: z.string().max(300).nullable().optional(), password: z.string().max(2000).nullable().optional(), url: z.string().url().nullable().optional(), notes: z.string().max(5000).nullable().optional() });

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/audit", { preHandler: requireRole(...adminRoles) }, async (request) => {
    const q = z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(request.query);
    let query = db().from("audit_logs").select("*,profiles:actor_profile_id(id,nickname,full_name,avatar_url)").order("created_at", { ascending: false }).limit(q.limit);
    if (q.search) query = query.or(`action.ilike.%${q.search}%,entity_type.ilike.%${q.search}%,entity_id.ilike.%${q.search}%`);
    return { logs: unwrap(await query) };
  });

  app.post("/api/v1/admin/vault/unlock", { preHandler: adminOnly }, async (request, reply) => {
    const pin = z.object({ pin: z.string().regex(/^\d{4}$/) }).parse(request.body).pin;
    if (!verifyVaultPin(pin)) return reply.code(401).send({ error: "Неверный код" });
    return { ok: true };
  });

  app.post("/api/v1/admin/vault", { preHandler: adminOnly }, async (request, reply) => {
    const body = z.object({ pin: z.string().regex(/^\d{4}$/), entry: vaultPayload }).parse(request.body);
    if (!verifyVaultPin(body.pin)) return reply.code(401).send({ error: "Неверный код" });
    const encrypted = encryptVault(body.entry);
    const row = unwrap(await db().from("vault_entries").insert({ title: body.entry.title, encrypted_payload: encrypted.encryptedPayload, nonce: encrypted.nonce, auth_tag: encrypted.authTag, created_by: request.principal!.profileId, updated_by: request.principal!.profileId }).select("id,title,created_at,updated_at").single());
    if (!row) throw new Error("Не удалось создать запись");
    await audit(request.principal!.profileId, "vault.created", "vault_entry", row.id); return reply.code(201).send(row);
  });

  app.post("/api/v1/admin/vault/list", { preHandler: adminOnly }, async (request, reply) => {
    const pin = z.object({ pin: z.string().regex(/^\d{4}$/) }).parse(request.body).pin; if (!verifyVaultPin(pin)) return reply.code(401).send({ error: "Неверный код" });
    const rows = unwrap(await db().from("vault_entries").select("*").order("title"));
    await audit(request.principal!.profileId, "vault.opened", "vault");
    return { entries: (rows ?? []).map((row) => ({ id: row.id, ...decryptVault(row), createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.post("/api/v1/admin/vault/migrate-legacy", { preHandler: adminOnly }, async (request, reply) => {
    const pin = z.object({ pin: z.string().regex(/^\d{4}$/) }).parse(request.body).pin; if (!verifyVaultPin(pin)) return reply.code(401).send({ error: "Неверный код" });
    const legacy = unwrap(await db().from("project_passwords").select("*").order("created_at")) ?? [];
    for (const item of legacy) {
      const payload = { title: item.title, login: item.login, password: item.password_value, url: item.url, notes: item.notes };
      const encrypted = encryptVault(payload);
      unwrap(await db().from("vault_entries").insert({ title: item.title, encrypted_payload: encrypted.encryptedPayload, nonce: encrypted.nonce, auth_tag: encrypted.authTag, created_by: request.principal!.profileId, updated_by: request.principal!.profileId }));
    }
    if (legacy.length) unwrap(await db().from("project_passwords").delete().in("id", legacy.map((item) => item.id)));
    await audit(request.principal!.profileId, "vault.legacy_migrated", "vault", undefined, { count: legacy.length });
    return { ok: true, migrated: legacy.length };
  });

  app.put("/api/v1/admin/vault/:id", { preHandler: adminOnly }, async (request, reply) => {
    const id = (request.params as { id: string }).id; const body = z.object({ pin: z.string().regex(/^\d{4}$/), entry: vaultPayload }).parse(request.body); if (!verifyVaultPin(body.pin)) return reply.code(401).send({ error: "Неверный код" });
    const encrypted = encryptVault(body.entry); const row = unwrap(await db().from("vault_entries").update({ title: body.entry.title, encrypted_payload: encrypted.encryptedPayload, nonce: encrypted.nonce, auth_tag: encrypted.authTag, updated_by: request.principal!.profileId, updated_at: new Date().toISOString() }).eq("id", id).select("id,title,updated_at").single());
    await audit(request.principal!.profileId, "vault.updated", "vault_entry", id); return row;
  });

  app.delete("/api/v1/admin/vault/:id", { preHandler: adminOnly }, async (request, reply) => {
    const id = (request.params as { id: string }).id; const pin = z.object({ pin: z.string().regex(/^\d{4}$/) }).parse(request.body).pin; if (!verifyVaultPin(pin)) return reply.code(401).send({ error: "Неверный код" });
    unwrap(await db().from("vault_entries").delete().eq("id", id)); await audit(request.principal!.profileId, "vault.deleted", "vault_entry", id); return reply.code(204).send();
  });
}
