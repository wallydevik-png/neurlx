// Persistent, redacted API request log. Every call to a real exchange
// endpoint is recorded here so operators can audit exactly what was sent,
// what came back, and how long it took. Secrets are never persisted.
import type { SupabaseClient } from "@supabase/supabase-js";

const SENSITIVE_KEYS = new Set([
  "signature", "apiKey", "api_key", "secret", "apiSecret", "api_secret",
  "password", "authorization", "x-mbx-apikey", "token",
]);

export function redact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

export interface ApiLogInput {
  userId: string;
  connectionId?: string | null;
  orderId?: string | null;
  venue: string;
  method: string;
  path: string;
  statusCode?: number | null;
  latencyMs?: number | null;
  params?: Record<string, unknown>;
  responseSnippet?: string | null;
  error?: string | null;
  isSigned?: boolean;
}

export async function logApiRequest(
  supabase: SupabaseClient,
  input: ApiLogInput,
): Promise<void> {
  const snippet = input.responseSnippet
    ? input.responseSnippet.slice(0, 2000)
    : null;
  try {
    await supabase.from("api_request_log").insert({
      user_id: input.userId,
      connection_id: input.connectionId ?? null,
      order_id: input.orderId ?? null,
      venue: input.venue,
      method: input.method,
      path: input.path,
      status_code: input.statusCode ?? null,
      latency_ms: input.latencyMs ?? null,
      request_params: redact(input.params ?? {}),
      response_snippet: snippet,
      error: input.error ?? null,
      is_signed: input.isSigned ?? false,
    });
  } catch {
    // Never let logging break execution.
  }
}
