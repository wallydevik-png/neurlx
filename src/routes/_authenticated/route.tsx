import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Read the persisted session from localStorage first (synchronous, no
    // network) so users are not bounced to /auth on flaky connections.
    // Only redirect when there is genuinely no session at all.
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) { setReady(true); return; }
      // Fallback: revalidate with the auth server before giving up.
      supabase.auth.getUser().then(({ data: u }) => {
        if (cancelled) return;
        if (u.user) setReady(true);
        else navigate({ to: "/auth", replace: true });
      }).catch(() => { if (!cancelled) navigate({ to: "/auth", replace: true }); });
    }).catch(() => {
      if (!cancelled) navigate({ to: "/auth", replace: true });
    });

    // Keep the layout in sync with sign-in / sign-out events.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) navigate({ to: "/auth", replace: true });
    });

    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, [navigate]);

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="text-sm text-muted-foreground">Loading NeurlX…</div>
      </div>
    );
  }

  return <Outlet />;
}
