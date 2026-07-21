// Shared REST helper for connector modules. Wraps fetch with:
//   - unified request/response logging (redacted, per NeurlX audit rules)
//   - latency measurement
//   - status classification (retryable vs terminal)
//
// Every first-class connector uses this so the Universal Broker Hub gets a
// consistent audit trail regardless of venue.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logApiRequest } from "@/lib/execution/requestLog.server";

export interface ConnectorLogCtx {
  supabase?: SupabaseClient;
  userId?: string;
  connectionId?: string | null;
  orderId?: string | null;
  venue: string;
}

export interface RestError extends Error {
  httpStatus?: number;
  retryable: boolean;
  body?: string;
}

export function classifyRestError(status: number, body: string, venue: string): RestError {
  const err = new Error(`${venue} error [${status}]: ${body.slice(0, 300)}`) as RestError;
  err.httpStatus = status;
  err.body = body;
  err.retryable = status === 429 || status >= 500;
  return err;
}

export interface DoRequestInput {
  ctx: ConnectorLogCtx;
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  params?: Record<string, unknown>;
  signed?: boolean;
}

export async function doRequest<T>(input: DoRequestInput): Promise<T> {
  const { ctx, method, url, path, headers, body, params, signed } = input;
  const started = Date.now();
  let res: Response | undefined;
  let text = "";
  try {
    res = await fetch(url, { method, headers, body });
    text = await res.text();
    if (!res.ok) throw classifyRestError(res.status, text, ctx.venue);
    if (ctx.supabase && ctx.userId) {
      await logApiRequest(ctx.supabase, {
        userId: ctx.userId, connectionId: ctx.connectionId ?? null,
        orderId: ctx.orderId ?? null, venue: ctx.venue, method, path,
        statusCode: res.status, latencyMs: Date.now() - started,
        params: params ?? {}, responseSnippet: text.slice(0, 500),
        isSigned: signed ?? false,
      });
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (e) {
    if (ctx.supabase && ctx.userId) {
      await logApiRequest(ctx.supabase, {
        userId: ctx.userId, connectionId: ctx.connectionId ?? null,
        orderId: ctx.orderId ?? null, venue: ctx.venue, method, path,
        statusCode: res?.status ?? null, latencyMs: Date.now() - started,
        params: params ?? {}, responseSnippet: text.slice(0, 500),
        error: e instanceof Error ? e.message : String(e),
        isSigned: signed ?? false,
      });
    }
    throw e;
  }
}
