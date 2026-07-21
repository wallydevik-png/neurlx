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

    supabase.auth.getUser().then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data.user) {
        navigate({ to: "/auth", replace: true });
        return;
      }
      setReady(true);
    }).catch(() => {
      if (!cancelled) navigate({ to: "/auth", replace: true });
    });

    return () => { cancelled = true; };
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
