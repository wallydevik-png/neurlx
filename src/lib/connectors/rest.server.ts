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
  /** Per-call deadline. Market-data scans use a shorter value so one stalled
   * venue cannot consume the autonomous cycle's entire request budget. */
  timeoutMs?: number;
  /** External cancellation (history gate slot budget / cycle abort). Aborting
   * this really cancels the socket, which is what keeps the provider's
   * concurrency accounting honest. */
  signal?: AbortSignal;
}

export async function doRequest<T>(input: DoRequestInput): Promise<T> {
  const { ctx, method, url, path, headers, body, params, signed } = input;
  const started = Date.now();
  let res: Response | undefined;
  let text = "";
  // Every outbound request previously had no timeout at all — a stalled
  // connection (no response, no error, just silence) would hang forever,
  // and since retries only kick in after a promise settles, nothing could
  // ever recover from it. That's the most likely explanation for a whole
  // autonomous cycle getting stuck for 7+ minutes with autonomous_runs left
  // unfinished: one request never resolved, so the cycle never finished.
  const requestTimeoutMs = Math.max(1_000, input.timeoutMs ?? 20_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const onExternalAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal });
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
    const aborted = e instanceof Error && e.name === "AbortError";
    // An abort raised by the CALLER's signal is a cancellation, not a provider
    // timeout — collapsing the two made a cycle-budget deferral look like the
    // broker failing to answer.
    const cancelled = aborted && Boolean(input.signal?.aborted);
    const err = aborted
      ? Object.assign(
        new Error(cancelled
          ? `Request to ${ctx.venue} cancelled: ${method} ${path}`
          : `Request to ${ctx.venue} timed out after ${requestTimeoutMs}ms: ${method} ${path}`),
        { retryable: !cancelled, cancelled },
      )
      : e;
    // Never await telemetry on the failure path: this runs while the caller
    // still owns a scarce provider slot.
    if (ctx.supabase && ctx.userId) {
      void logApiRequest(ctx.supabase, {
        userId: ctx.userId, connectionId: ctx.connectionId ?? null,
        orderId: ctx.orderId ?? null, venue: ctx.venue, method, path,
        statusCode: res?.status ?? null, latencyMs: Date.now() - started,
        params: params ?? {}, responseSnippet: text.slice(0, 500),
        error: err instanceof Error ? err.message : String(err),
        isSigned: signed ?? false,
      }).catch(() => undefined);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener("abort", onExternalAbort);
  }
}
