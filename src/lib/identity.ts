import { db, rolesFor, unwrap } from "./db.js";

export type IdentityProvider = "telegram" | "itmo_id" | "supabase";

export interface IdentityInput {
  provider: IdentityProvider;
  subject: string;
  username?: string | null;
  fullName?: string | null;
  avatarUrl?: string | null;
  isuNumber?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown>;
  linkToProfileId?: string;
}

export async function upsertIdentity(input: IdentityInput) {
  const existing = unwrap(await db().from("account_identities")
    .select("profile_id").eq("provider", input.provider).eq("provider_subject", input.subject).maybeSingle());
  let profileId = existing?.profile_id as string | undefined;

  if (existing && input.linkToProfileId && existing.profile_id !== input.linkToProfileId) {
    throw Object.assign(new Error("Эта учётная запись уже привязана к другому профилю"), { statusCode: 409 });
  }

  if (!profileId) {
    profileId = input.linkToProfileId;
    if (!profileId && input.isuNumber) {
      const matched = unwrap(await db().from("profiles").select("id").eq("isu_number", input.isuNumber).maybeSingle());
      profileId = matched?.id;
    }
    if (!profileId) {
      const nickname = input.username || input.fullName || `user_${input.subject.slice(-6)}`;
      const created = unwrap(await db().from("profiles").insert({
        auth_user_id: input.provider === "supabase" ? input.subject : null,
        isu_number: input.isuNumber ?? null,
        nickname: nickname.slice(0, 80),
        full_name: input.fullName ?? null,
        avatar_url: input.avatarUrl ?? null,
        telegram_username: input.provider === "telegram" ? input.username : null,
      }).select("id").single());
      if (!created) throw new Error("Не удалось создать профиль");
      profileId = created.id;
    }
    unwrap(await db().from("account_identities").insert({
      profile_id: profileId,
      provider: input.provider,
      provider_subject: input.subject,
      username: input.username ?? null,
      metadata: { ...input.metadata, email: input.email, isuNumber: input.isuNumber },
      verified_at: new Date().toISOString(),
    }));
    unwrap(await db().from("profile_roles").upsert({ profile_id: profileId, role: "participant" }, { onConflict: "profile_id,role" }));
  } else {
    unwrap(await db().from("account_identities").update({
      username: input.username ?? null,
      metadata: { ...input.metadata, email: input.email, isuNumber: input.isuNumber },
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("provider", input.provider).eq("provider_subject", input.subject));
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.fullName) patch.full_name = input.fullName;
  if (input.avatarUrl) patch.avatar_url = input.avatarUrl;
  if (input.isuNumber) patch.isu_number = input.isuNumber;
  if (input.provider === "telegram" && input.username) patch.telegram_username = input.username;
  unwrap(await db().from("profiles").update(patch).eq("id", profileId));

  if (!profileId) throw new Error("Не удалось определить профиль");
  return { profileId, roles: await rolesFor(profileId) };
}
