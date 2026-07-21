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

async function key(): Promise<CryptoKey> {
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

export async function encryptJSON(value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return bytesToBase64(packed);
}

export async function decryptJSON<T = unknown>(stored: string): Promise<T> {
  const packed = base64ToBytes(stored);
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(), ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
