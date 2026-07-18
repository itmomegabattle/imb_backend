import assert from "node:assert/strict";
import test from "node:test";
import { randomCode, sha256Base64Url } from "./oidc.js";

test("creates Telegram-compatible short opaque state", () => {
  const state = randomCode(18);
  assert.match(state, /^[A-Za-z0-9_-]{20,64}$/);
  assert.ok(state.length < 64);
});

test("creates an S256 PKCE challenge", () => {
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  const challenge = sha256Base64Url(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(sha256Base64Url(`${verifier}modified`), challenge);
});
