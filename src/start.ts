import { createStart, createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { supabase } from "@/integrations/supabase/client";

/**
 * Keep the browser's access token fresh before every RPC.
 *
 * `attachSupabaseAuth` reads whatever `getSession()` returns. On a published
 * (non-preview) origin there is no editor broker to hand the session back, so
 * a tab left open past the token's expiry would attach an expired JWT and the
 * server would reject every call. Refreshing just before the attacher runs
 * keeps published/Cloudflare deployments behaving like the preview.
 */
const ensureFreshSupabaseSession = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (session?.expires_at) {
        const secondsLeft = session.expires_at - Math.floor(Date.now() / 1000);
        if (secondsLeft < 60) await supabase.auth.refreshSession();
      }
    } catch {
      /* offline or no session — the server decides what to do about it */
    }
    try {
      return await next();
    } catch (error) {
      // A hard 401 means the stored session is gone or unusable. Send the user
      // to sign-in instead of leaving a broken page behind.
      const status = error instanceof Response ? error.status : undefined;
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (status === 401 || /unauthorized/i.test(message)) {
        const { data } = await supabase.auth.getSession();
        if (!data.session && typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
          window.location.assign("/auth");
        }
      }
      throw error;
    }
  },
);


function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && /unauthor/i.test(error.message);
}

function wantsJson(): boolean {
  try {
    const request = getRequest();
    if (!request) return false;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_serverFn/")) return true;
    return (request.headers.get("accept") ?? "").includes("application/json");
  } catch {
    return false;
  }
}

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    // Redirects, notFound and raw Responses are control flow, not failures.
    if (error instanceof Response) throw error;
    if (error != null && typeof error === "object" && ("statusCode" in error || "isRedirect" in error || "isNotFound" in error)) {
      throw error;
    }

    const unauthorized = isUnauthorized(error);
    if (!unauthorized) console.error(error);

    // RPC callers need a machine-readable status. Returning the HTML error page
    // here is what made an expired session look like "This page didn't load".
    if (unauthorized || wantsJson()) {
      const status = unauthorized ? 401 : 500;
      return new Response(
        JSON.stringify({
          error: unauthorized ? "unauthorized" : "internal_error",
          message: error instanceof Error ? error.message : String(error),
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

/**
 * Server-side wrapper around every server function.
 *
 * Errors thrown inside a server function are swallowed by the request layer
 * before `errorMiddleware` sees them, which turned an expired/missing session
 * into a full "This page didn't load" HTML page instead of a 401 the client
 * can act on. Rethrowing a real `Response` keeps the status machine-readable
 * on preview, published and Cloudflare alike.
 */
const serverFnErrorBoundary = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof Response) throw error;
      if (error != null && typeof error === "object" && ("isRedirect" in error || "isNotFound" in error || "statusCode" in error)) {
        throw error;
      }
      const unauthorized = isUnauthorized(error);
      if (!unauthorized) console.error(error);
      throw new Response(
        JSON.stringify({
          error: unauthorized ? "unauthorized" : "internal_error",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: unauthorized ? 401 : 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  },
);

export const startInstance = createStart(() => ({
  functionMiddleware: [serverFnErrorBoundary, ensureFreshSupabaseSession, attachSupabaseAuth],
  requestMiddleware: [errorMiddleware],

}));
