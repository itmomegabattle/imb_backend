import assert from "node:assert/strict";
import test from "node:test";
import { issueTelegramOidcState, sha256Base64Url, verifyTelegramOidcState } from "./oidc.js";

test("binds Telegram OIDC state to the browser PKCE challenge", async () => {
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  const codeChallenge = sha256Base64Url(verifier);
  const token = await issueTelegramOidcState({
    returnTo: "https://example.test/ratings",
    nonce: "telegram-login-nonce",
    codeChallenge,
  });

  const state = await verifyTelegramOidcState(token);
  assert.equal(state.returnTo, "https://example.test/ratings");
  assert.equal(state.nonce, "telegram-login-nonce");
  assert.equal(state.codeChallenge, codeChallenge);
  assert.notEqual(sha256Base64Url(`${verifier}modified`), state.codeChallenge);
});
