import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireService } from "../../lib/service-auth.js";
import { youGile } from "./client.js";
import { env } from "../../config/env.js";
import { db, unwrap } from "../../lib/db.js";
import { requireRole } from "../../lib/session.js";

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  columnId: z.string().min(1),
  description: z.string().max(20_000).optional(),
  deadline: z.object({ deadline: z.number().int(), startDate: z.number().int().optional() }).optional(),
  assigned: z.array(z.string()).optional(),
});
const patchTaskSchema = createTaskSchema.partial().passthrough();

export async function youGileRoutes(app: FastifyInstance) {
  const orgOnly = requireService("org_bot");

  app.get("/tasks", { preHandler: orgOnly }, async (request) =>
    youGile.listTasks(request.query as Record<string, string | number | undefined>),
  );

  app.post("/tasks", { preHandler: orgOnly }, async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid YouGile task", details: parsed.error.flatten() });
    return reply.code(201).send(await youGile.createTask(parsed.data));
  });

  app.patch("/tasks/:taskId", { preHandler: orgOnly }, async (request, reply) => {
    const parsed = patchTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid YouGile task patch", details: parsed.error.flatten() });
    return youGile.updateTask((request.params as { taskId: string }).taskId, parsed.data);
  });

  app.delete("/tasks/:taskId", { preHandler: orgOnly }, async (request) =>
    youGile.deleteTask((request.params as { taskId: string }).taskId),
  );

  app.post("/tasks/:taskId/comments", { preHandler: orgOnly }, async (request, reply) => {
    const parsed = z.object({ text: z.string().min(1).max(20_000), actor: z.string().max(200).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid comment" });
    const text = parsed.data.actor ? `${parsed.data.actor} через MegaBot:\n${parsed.data.text}` : parsed.data.text;
    return reply.code(201).send(await youGile.addComment((request.params as { taskId: string }).taskId, text));
  });

  app.post("/sync", { preHandler: requireRole("organizer", "admin", "site_admin") }, async (request) => {
    const external = await youGile.listTasks({ projectId: env.YOUGILE_PROJECT_ID }) as any;
    const items = external.content ?? external.items ?? external ?? [];
    let synced = 0;
    for (const item of items) {
      if (!item.id || !item.title) continue;
      const row = { yougile_task_id: String(item.id), title: String(item.title), description: item.description ?? null, deadline_at: item.deadline?.deadline ? new Date(item.deadline.deadline).toISOString() : null, yougile_column_id: item.columnId ?? null, source: "yougile", raw_yougile: item, sync_status: "synced", last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      unwrap(await db().from("organizer_tasks").upsert(row, { onConflict: "yougile_task_id" })); synced++;
    }
    return { ok: true, synced };
  });

  app.put("/user-mappings/:externalUserId", { preHandler: requireRole("admin", "site_admin") }, async (request) => {
    const externalUserId = (request.params as { externalUserId: string }).externalUserId;
    const profileId = z.object({ profileId: z.string().uuid() }).parse(request.body).profileId;
    unwrap(await db().from("integration_user_mappings").upsert({ integration: "yougile", external_user_id: externalUserId, profile_id: profileId }, { onConflict: "integration,external_user_id" }));
    return { ok: true };
  });

  app.post("/webhook", async (request, reply) => {
    if (!env.YOUGILE_WEBHOOK_SECRET || request.headers["x-webhook-secret"] !== env.YOUGILE_WEBHOOK_SECRET) return reply.code(401).send({ error: "Invalid webhook secret" });
    const body = z.object({ event: z.string(), task: z.record(z.string(), z.unknown()).optional(), taskId: z.union([z.string(), z.number()]).optional() }).passthrough().parse(request.body);
    const task = body.task as any; const taskId = String(task?.id ?? body.taskId ?? "");
    if (body.event.includes("delete") && taskId) unwrap(await db().from("organizer_tasks").delete().eq("yougile_task_id", taskId));
    else if (taskId && task?.title) unwrap(await db().from("organizer_tasks").upsert({ yougile_task_id: taskId, title: String(task.title), description: task.description ?? null, deadline_at: task.deadline?.deadline ? new Date(task.deadline.deadline).toISOString() : null, yougile_column_id: task.columnId ?? null, source: "yougile", raw_yougile: task, sync_status: "synced", last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "yougile_task_id" }));
    return { ok: true };
  });
}
