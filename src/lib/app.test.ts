import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../app.js";

test("health endpoint starts without optional integrations", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().service, "itmomegabattle-backend");
  await app.close();
});

test("auth status is anonymous without a session", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/auth/me" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: false,
    principal: null,
    profile: null,
  });
  await app.close();
});

test("Telegram OIDC reports missing BotFather configuration", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/auth/telegram/oidc/start",
    payload: {
      codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12_3456789-abc",
      returnTo: "http://localhost:5173/ratings",
    },
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /BotFather/);
  await app.close();
});

test("participant bot endpoints reject missing service token", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/participant/bot/users/upsert",
    payload: { telegramId: 1, firstName: "Test" },
  });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test("organizer API is not part of the ecosystem", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/v1/organizer/dashboard" });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("unknown content resource returns 404", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/v1/content/unknown" });
  assert.equal(response.statusCode, 404);
  await app.close();
});
