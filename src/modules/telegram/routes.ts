import type { FastifyInstance } from "fastify";

export async function telegramRoutes(app: FastifyInstance) {
  app.post("/telegram/participant-bot/webhook", async (request) => ({
    ok: true,
    bot: "participant",
    received: Boolean(request.body),
    message: "Participant bot webhook placeholder",
  }));

  app.post("/telegram/org-bot/webhook", async (request) => ({
    ok: true,
    bot: "org",
    received: Boolean(request.body),
    message: "Organizer bot webhook placeholder",
  }));
}
