import type { FastifyInstance } from "fastify";
import { requireSupabaseAdmin } from "../../lib/supabase.js";

export async function profileRoutes(app: FastifyInstance) {
  app.get("/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase
      .from("profiles")
      .select("id, isu_number, nickname, full_name, faculty, bio, avatar_url, telegram_username, instagram_username, social_links, megaballs, is_admin, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) return reply.code(500).send({ error: error.message });
    if (!data) return reply.code(404).send({ error: "Profile not found" });

    return data;
  });
}
