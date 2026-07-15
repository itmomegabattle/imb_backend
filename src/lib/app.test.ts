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
