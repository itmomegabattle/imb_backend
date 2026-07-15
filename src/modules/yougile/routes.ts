import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireService } from "../../lib/service-auth.js";
import { youGile } from "./client.js";

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
}
