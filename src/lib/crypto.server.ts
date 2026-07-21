// Server-only credential encryption (AES-256-GCM), implemented with Web Crypto
// so production Worker builds never depend on Node's crypto runtime.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function keyV2(): Promise<CryptoKey> {
  const raw = process.env.CREDENTIAL_ENC_KEY;
  if (!raw) throw new Error("CREDENTIAL_ENC_KEY not set");
  // Cloudflare Workers cap PBKDF2 iterations and older deployments were
  // repeatedly failing credential saves there. Use a Worker-safe SHA-256 KDF
  // instead: deterministic, no runtime iteration cap, and imports cleanly as
  // an AES-256-GCM key.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`neurlx-credential-v2:${raw}`),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function legacyPbkdf2Key(): Promise<CryptoKey> {
  const raw = process.env.CREDENTIAL_ENC_KEY;
  if (!raw) throw new Error("CREDENTIAL_ENC_KEY not set");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(raw),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("trading-platform-v1"), iterations: 100_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJSON(value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyV2(),
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return `v2:${bytesToBase64(packed)}`;
}

export async function decryptJSON<T = unknown>(stored: string): Promise<T> {
  const isV2 = stored.startsWith("v2:");
  const packed = base64ToBytes(isV2 ? stored.slice(3) : stored);
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    isV2 ? await keyV2() : await legacyPbkdf2Key(),
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
