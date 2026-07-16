// Server-only credential encryption (AES-256-GCM).
// Never import this from client bundles.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

function key(): Buffer {
  const raw = process.env.CREDENTIAL_ENC_KEY;
  if (!raw) throw new Error("CREDENTIAL_ENC_KEY not set");
  // Derive a 32-byte key from the stored secret deterministically.
  return scryptSync(raw, "trading-platform-v1", 32);
}

export function encryptJSON(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptJSON<T = unknown>(stored: string): T {
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
