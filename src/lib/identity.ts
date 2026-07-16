import { db, rolesFor, unwrap } from "./db.js";
import { env } from "../config/env.js";

export type IdentityProvider = "telegram" | "itmo_id";

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
      const nickname = (input.username || input.fullName || `user_${input.subject.slice(-6)}`).slice(0, 80);
      let createdResult = await db().from("profiles").insert({
        isu_number: input.isuNumber ?? null,
        nickname,
        full_name: input.fullName ?? null,
        avatar_url: input.avatarUrl ?? null,
        telegram_username: input.provider === "telegram" ? input.username : null,
      }).select("id").single();
      if (createdResult.error?.code === "23505") {
        const fallbackNickname = `${nickname.slice(0, 67)}_${input.subject.slice(-8)}`;
        createdResult = await db().from("profiles").insert({
          isu_number: input.isuNumber ?? null,
          nickname: fallbackNickname,
          full_name: input.fullName ?? null,
          avatar_url: input.avatarUrl ?? null,
          telegram_username: input.provider === "telegram" ? input.username : null,
        }).select("id").single();
      }
      if (createdResult.error) throw createdResult.error;
      const created = createdResult.data;
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

  if (input.provider === "telegram" && input.username?.replace(/^@/, "").toLowerCase() === env.BOOTSTRAP_ADMIN_USERNAME.replace(/^@/, "").toLowerCase()) {
    unwrap(await db().from("profile_roles").upsert({ profile_id: profileId, role: "admin", granted_by: profileId }, { onConflict: "profile_id,role" }));
  }

  if (!profileId) throw new Error("Не удалось определить профиль");
  return { profileId, roles: await rolesFor(profileId) };
}
