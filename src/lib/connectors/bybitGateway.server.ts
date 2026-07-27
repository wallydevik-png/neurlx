import type { SupabaseClient } from "@supabase/supabase-js";
import { hmacSha256Hex } from "./signing.server";

export type GatewayStatus = "ONLINE" | "OFFLINE" | "BLOCKED" | "UNCONFIGURED";

export interface BybitGatewayTarget {
  url: string;
  region: string;
  secret: string;
  source: "connection" | "environment";
}

export interface BybitGatewayEnvelope {
  method: "GET" | "POST";
  path: string;
  queryString?: string;
  body?: string;
  auth?: {
    apiKey: string;
    apiSecret: string;
  };
}

export interface BybitGatewayCallMeta {
  target: BybitGatewayTarget;
  latencyMs: number;
  switched: boolean;
}

export function isRegionBlockedMessage(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes("cloudfront")
    || msg.includes("block access from your country")
    || msg.includes("country restricted")
    || msg.includes("blocked country")
    || msg.includes("server region")
    || msg.includes("u.s ip")
    || msg.includes("us ip")
    || msg.includes("403");
}

export function isAuthenticatedBybitPath(path: string): boolean {
  return path.startsWith("/v5/account/")
    || path.startsWith("/v5/order/")
    || path.startsWith("/v5/position/")
    || path.startsWith("/v5/asset/")
    || path.startsWith("/v5/user/")
    || path.startsWith("/v5/execution/");
}

export function bybitGatewayRequiredMessage(path: string): string {
  return `Bybit regional gateway required for ${path}. NeurlX will not send authenticated Bybit wallet, order, position, asset, or permission requests from the hosted Cloudflare runtime. Configure an HTTPS Bybit gateway in an allowed region, then retry.`;
}

export function regionBlockedMessage(path: string): string {
  return `Bybit is rejecting the active gateway/server region for ${path}. NeurlX will fail over to another configured regional gateway when available; otherwise live execution is queued until a healthy gateway is online.`;
}

function splitUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map(v => v.trim())
    .filter(v => v.length > 0);
}

function cleanGatewayUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getBybitGatewayTargets(credentials: Record<string, string>): BybitGatewayTarget[] {
  const targets: BybitGatewayTarget[] = [];
  const add = (urls: string[], region: string, secret: string, source: BybitGatewayTarget["source"]) => {
    for (const rawUrl of urls) {
      const url = cleanGatewayUrl(rawUrl);
      if (!url || targets.some(t => t.url === url)) continue;
      targets.push({ url, region, secret, source });
    }
  };

  add(
    splitUrls(credentials.regionalGatewayUrl || credentials.gatewayUrl),
    credentials.gatewayRegion || credentials.regionalGatewayRegion || process.env.GATEWAY_REGION || "configured",
    credentials.regionalGatewaySecret || credentials.gatewaySecret || process.env.BYBIT_GATEWAY_SECRET || process.env.BYBIT_REGIONAL_GATEWAY_SECRET || "",
    "connection",
  );
  add(
    splitUrls(process.env.BYBIT_GATEWAY_URLS),
    process.env.GATEWAY_REGION || "environment",
    process.env.BYBIT_GATEWAY_SECRET || process.env.BYBIT_REGIONAL_GATEWAY_SECRET || "",
    "environment",
  );
  add(
    splitUrls(process.env.BYBIT_GATEWAY_URL || process.env.BYBIT_REGIONAL_GATEWAY_URL),
    process.env.GATEWAY_REGION || "environment",
    process.env.BYBIT_GATEWAY_SECRET || process.env.BYBIT_REGIONAL_GATEWAY_SECRET || "",
    "environment",
  );
  return targets;
}

async function signedGatewayHeaders(target: BybitGatewayTarget, payload: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-NeurlX-Gateway-Region": target.region,
  };
  if (target.secret) {
    headers["X-NeurlX-Signature"] = await hmacSha256Hex(target.secret, payload);
  }
  return headers;
}

export async function callBybitGateway<T>(input: {
  targets: BybitGatewayTarget[];
  envelope: BybitGatewayEnvelope;
  log?: {
    supabase?: SupabaseClient;
    userId?: string;
    connectionId?: string | null;
    orderId?: string | null;
    signed?: boolean;
  };
}): Promise<{ data: T; meta: BybitGatewayCallMeta }> {
  const { logApiRequest } = await import("@/lib/execution/requestLog.server");
  let lastError: unknown = null;
  for (let index = 0; index < input.targets.length; index++) {
    const target = input.targets[index];
    const payload = JSON.stringify(input.envelope);
    const headers = await signedGatewayHeaders(target, payload);
    const started = Date.now();
    let statusCode: number | null = null;
    let text = "";
    try {
      const res = await fetch(target.url, { method: "POST", headers, body: payload });
      statusCode = res.status;
      text = await res.text();
      const latencyMs = Date.now() - started;
      if (input.log?.supabase && input.log.userId) {
        await logApiRequest(input.log.supabase, {
          userId: input.log.userId,
          connectionId: input.log.connectionId ?? null,
          orderId: input.log.orderId ?? null,
          venue: `bybit-gateway:${target.region}`,
          method: input.envelope.method,
          path: input.envelope.path,
          statusCode,
          latencyMs,
          params: { gateway: target.url, region: target.region, queryString: input.envelope.queryString ?? "" },
          responseSnippet: text.slice(0, 500),
          isSigned: input.log.signed ?? false,
        });
      }
      if (!res.ok) {
        const error = new Error(`Bybit gateway ${target.region} error [${res.status}]: ${text.slice(0, 300)}`);
        if (res.status === 403 || isRegionBlockedMessage(text)) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const parsed = (text ? JSON.parse(text) : {}) as { data?: unknown; body?: unknown };
      return {
        data: (parsed.data ?? parsed.body ?? parsed) as T,
        meta: { target, latencyMs, switched: index > 0 },
      };
    } catch (error) {
      lastError = error;
      if (input.log?.supabase && input.log.userId) {
        await logApiRequest(input.log.supabase, {
          userId: input.log.userId,
          connectionId: input.log.connectionId ?? null,
          orderId: input.log.orderId ?? null,
          venue: `bybit-gateway:${target.region}`,
          method: input.envelope.method,
          path: input.envelope.path,
          statusCode,
          latencyMs: Date.now() - started,
          params: { gateway: target.url, region: target.region, queryString: input.envelope.queryString ?? "" },
          responseSnippet: text.slice(0, 500),
          error: error instanceof Error ? error.message : String(error),
          isSigned: input.log.signed ?? false,
        });
      }
      if (isRegionBlockedMessage(error) || isRegionBlockedMessage(text)) continue;
      throw error;
    }
  }
  if (isRegionBlockedMessage(lastError)) {
    throw new Error(regionBlockedMessage(input.envelope.path));
  }
  throw lastError instanceof Error ? lastError : new Error("No Bybit regional gateway is reachable.");
}

export async function updateGatewayHealthRecord(input: {
  supabase?: SupabaseClient;
  userId?: string;
  connectionId?: string | null;
  status: GatewayStatus;
  region?: string;
  url?: string;
  latencyMs?: number | null;
  message?: string;
  switched?: boolean;
}) {
  if (!input.supabase || !input.userId || !input.connectionId) return;
  const patch = {
    gateway_status: {
      status: input.status,
      region: input.region ?? null,
      url: input.url ?? null,
      latencyMs: input.latencyMs ?? null,
      message: input.message ?? null,
      checkedAt: new Date().toISOString(),
    },
    gateway_last_health_at: new Date().toISOString(),
    gateway_current_url: input.url ?? null,
    gateway_region: input.region ?? null,
    gateway_last_region_switch_at: input.switched ? new Date().toISOString() : undefined,
    latency_ms: input.latencyMs ?? null,
    health: input.status === "ONLINE" ? "healthy" : input.status === "BLOCKED" ? "danger" : "warning",
    last_error: input.status === "ONLINE" ? null : input.message ?? input.status,
    last_sync_at: new Date().toISOString(),
  };
  const sanitized = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const db = input.supabase as unknown as { from: (table: string) => { update: (values: Record<string, unknown>) => { eq: (column: string, value: string) => { eq: (column: string, value: string) => Promise<unknown> } } } } };
  await db.from("exchange_connections").update(sanitized).eq("id", input.connectionId).eq("user_id", input.userId);
}