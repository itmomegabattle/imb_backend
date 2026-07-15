import { createClient } from "@supabase/supabase-js";
import { env, isSupabaseServerConfigured } from "../config/env.js";

export const supabaseAdmin = isSupabaseServerConfigured
  ? createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

export function requireSupabaseAdmin() {
  if (!supabaseAdmin) {
    throw new Error("Supabase server client is not configured");
  }

  return supabaseAdmin;
}
