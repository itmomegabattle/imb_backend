import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

function key() { if (!env.VAULT_ENCRYPTION_KEY) throw new Error("VAULT_ENCRYPTION_KEY is not configured"); return createHash("sha256").update(env.VAULT_ENCRYPTION_KEY).digest(); }
export function verifyVaultPin(pin: string) { if (!env.VAULT_PIN_HASH) return false; const actual = createHash("sha256").update(pin).digest("hex"); const a = Buffer.from(actual); const b = Buffer.from(env.VAULT_PIN_HASH); return a.length === b.length && timingSafeEqual(a,b); }
export function encryptVault(value: unknown) { const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), nonce); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]); return { encryptedPayload: encrypted.toString("base64"), nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64") }; }
export function decryptVault(row: { encrypted_payload: string; nonce: string; auth_tag: string }) { const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.nonce, "base64")); decipher.setAuthTag(Buffer.from(row.auth_tag, "base64")); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.encrypted_payload, "base64")), decipher.final()]).toString("utf8")); }
