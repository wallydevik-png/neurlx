import { useEffect, useState, useCallback } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function usePWA() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [supportsPush, setSupportsPush] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(window.navigator.onLine);
    setIsInstalled(window.matchMedia("(display-mode: standalone)").matches);
    setSupportsPush("PushManager" in window && "serviceWorker" in navigator);

    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setIsInstalled(true);
      setInstallPrompt(null);
    }
  }, [installPrompt]);

  const subscribePush = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) return sub;
    return await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "",
      ),
    });
  }, []);

  return { installPrompt, isInstalled, isOnline, supportsPush, install, subscribePush };
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return new Uint8Array(rawData.split("").map((c) => c.charCodeAt(0)));
}

export function vibrate(pattern: number | number[] = 20) {
  if (typeof window !== "undefined" && "vibrator" in navigator) {
    (navigator as Navigator).vibrate?.(pattern);
  }
}
