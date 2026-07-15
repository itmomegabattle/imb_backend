import assert from "node:assert/strict";
import test from "node:test";
import { issueSession, verifySession } from "./session.js";

test("issues and verifies an ecosystem session", async () => {
  const token = await issueSession({ profileId: "00000000-0000-4000-8000-000000000001", roles: ["participant"], provider: "telegram", providerSubject: "123" });
  const principal = await verifySession(token);
  assert.equal(principal.profileId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(principal.roles, ["participant"]);
  assert.equal(principal.providerSubject, "123");
});

test("rejects a modified ecosystem session", async () => {
  const token = await issueSession({ profileId: "00000000-0000-4000-8000-000000000001", roles: ["participant"], provider: "telegram", providerSubject: "123" });
  await assert.rejects(() => verifySession(`${token.slice(0, -2)}xx`));
});
