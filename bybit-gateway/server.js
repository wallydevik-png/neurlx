import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const BYBIT_API_BASE = (process.env.BYBIT_API_BASE || "https://api.bybit.com").replace(/\/+$/, "");
const SHARED_SECRET = process.env.GATEWAY_SHARED_SECRET || process.env.BYBIT_GATEWAY_SECRET || "";
const ALLOWED_PREFIXES = ["/v5/account/", "/v5/order/", "/v5/position/", "/v5/asset/", "/v5/user/", "/v5/execution/", "/v5/market/"];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function verifySignature(payload, signature) {
  if (!SHARED_SECRET) return true;
  if (!signature) return false;
  const expected = createHmac("sha256", SHARED_SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(signature), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(new Error("Payload too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function filteredHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-bapi-") || lower === "content-type") out[key] = String(value);
  }
  return out;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, region: process.env.GATEWAY_REGION || "regional", bybitBase: BYBIT_API_BASE });
      return;
    }
    if (req.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/bybit")) {
      json(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const payload = await readBody(req);
    if (!verifySignature(payload, req.headers["x-neurlx-signature"])) {
      json(res, 401, { ok: false, error: "invalid_signature" });
      return;
    }
    const envelope = JSON.parse(payload || "{}");
    const method = envelope.method === "POST" ? "POST" : "GET";
    const path = String(envelope.path || "");
    if (!ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix))) {
      json(res, 403, { ok: false, error: "path_not_allowed" });
      return;
    }
    const query = envelope.queryString ? `?${String(envelope.queryString).replace(/^\?/, "")}` : "";
    const upstream = await fetch(`${BYBIT_API_BASE}${path}${query}`, {
      method,
      headers: filteredHeaders(envelope.headers),
      body: method === "POST" ? String(envelope.body || "") : undefined,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, () => console.log(`NeurlX Bybit regional gateway listening on ${PORT}`));