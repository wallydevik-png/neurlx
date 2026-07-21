// Shared Web Crypto signing primitives for every REST connector.
// Cloudflare Worker runtime — no Node crypto module. All algorithms below
// are supported by SubtleCrypto natively.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** HMAC-SHA256 → hex. Used by Binance, Bybit, MEXC, HTX, Gate.io. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** HMAC-SHA256 → base64. Used by OKX, KuCoin, Bitget, Crypto.com. */
export async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return toBase64(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** HMAC-SHA512 raw bytes. Building block for Kraken's compound signature. */
export async function hmacSha512Raw(secretBytes: Uint8Array, messageBytes: Uint8Array): Promise<ArrayBuffer> {
  const keyBuf = secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength) as ArrayBuffer;
  const msgBuf = messageBytes.buffer.slice(messageBytes.byteOffset, messageBytes.byteOffset + messageBytes.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw", keyBuf, { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, msgBuf);
}

/** SHA-256 raw bytes. Used by Kraken's signature preimage. */
export async function sha256Raw(bytes: Uint8Array): Promise<ArrayBuffer> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return crypto.subtle.digest("SHA-256", buf);
}

/**
 * Kraken's documented signature:
 *   HMAC-SHA512(base64_decode(privateKey), URI_path + SHA256(nonce + postData))
 * → base64.
 */
export async function krakenSignature(
  privateKeyBase64: string,
  uriPath: string,
  nonce: string,
  postData: string,
): Promise<string> {
  const noncePayload = enc.encode(nonce + postData);
  const digest = new Uint8Array(await sha256Raw(noncePayload));
  const message = new Uint8Array(uriPath.length + digest.length);
  message.set(enc.encode(uriPath), 0);
  message.set(digest, uriPath.length);
  const secretBytes = fromBase64(privateKeyBase64);
  return toBase64(await hmacSha512Raw(secretBytes, message));
}

/** Small helpers exposed for connectors that need them directly. */
export const _internals = { toHex, toBase64, fromBase64 };
