import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface TelegramInitData {
  user: TelegramWebAppUser;
  authDate: number;
  queryId?: string;
}

export class TelegramInitDataError extends Error {}

export function verifyTelegramInitData(
  rawInitData: string,
  botToken: string,
  maxAgeSeconds = 86_400,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramInitData {
  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new TelegramInitDataError("Telegram hash is missing");

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const received = Buffer.from(receivedHash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");
  if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) {
    throw new TelegramInitDataError("Telegram signature is invalid");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate)) throw new TelegramInitDataError("Telegram auth_date is invalid");
  if (authDate > nowSeconds + 30 || nowSeconds - authDate > maxAgeSeconds) {
    throw new TelegramInitDataError("Telegram initData has expired");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new TelegramInitDataError("Telegram user is missing");
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(rawUser) as TelegramWebAppUser;
  } catch {
    throw new TelegramInitDataError("Telegram user is invalid");
  }
  if (!Number.isSafeInteger(user.id) || !user.first_name) {
    throw new TelegramInitDataError("Telegram user is incomplete");
  }

  return { user, authDate, queryId: params.get("query_id") ?? undefined };
}
