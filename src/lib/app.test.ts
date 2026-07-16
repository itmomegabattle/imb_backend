import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../build-app.js";

test("health endpoint starts without optional integrations", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().service, "itmomegabattle-backend");
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
