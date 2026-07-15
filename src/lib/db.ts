import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAdmin } from "./supabase.js";

export function db(): SupabaseClient {
  return requireSupabaseAdmin();
}

export function unwrap<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

export async function rolesFor(profileId: string) {
  const rows = unwrap(await db().from("profile_roles").select("role").eq("profile_id", profileId));
  return (rows ?? []).map((row) => row.role) as Array<"participant" | "organizer" | "admin" | "site_admin">;
}

export async function profileForIdentity(provider: string, subject: string) {
  return unwrap(
    await db()
      .from("account_identities")
      .select("profile_id")
      .eq("provider", provider)
      .eq("provider_subject", subject)
      .maybeSingle(),
  );
}

export async function audit(actorProfileId: string | null, action: string, entityType: string, entityId?: string, details: unknown = {}) {
  unwrap(await db().from("audit_logs").insert({
    actor_profile_id: actorProfileId,
    action,
    entity_type: entityType,
    entity_id: entityId ?? null,
    details,
  }));
  await db().rpc("trim_audit_logs", { p_keep: 50 });
}
