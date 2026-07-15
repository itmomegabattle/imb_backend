import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { TelegramInitDataError, verifyTelegramInitData } from "./telegram-init-data.js";

function signedInitData(token: string, authDate: number) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AA-test",
    user: JSON.stringify({ id: 123456, first_name: "Никита", username: "test_user" }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

test("accepts correctly signed Telegram initData", () => {
  const now = 1_800_000_000;
  const result = verifyTelegramInitData(signedInitData("123:secret", now - 10), "123:secret", 60, now);
  assert.equal(result.user.id, 123456);
  assert.equal(result.user.username, "test_user");
});

test("rejects tampered Telegram initData", () => {
  const now = 1_800_000_000;
  const tampered = signedInitData("123:secret", now).replace("test_user", "attacker");
  assert.throws(() => verifyTelegramInitData(tampered, "123:secret", 60, now), TelegramInitDataError);
});

test("rejects expired Telegram initData", () => {
  const now = 1_800_000_000;
  assert.throws(() => verifyTelegramInitData(signedInitData("123:secret", now - 61), "123:secret", 60, now));
});
