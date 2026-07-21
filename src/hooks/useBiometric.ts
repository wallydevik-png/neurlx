import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
} from "@/lib/webauthn.functions";

export function useBiometric() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = useServerFn(registrationOptions);
  const verifyReg = useServerFn(verifyRegistration);
  const authOpts = useServerFn(authenticationOptions);
  const verifyAuth = useServerFn(verifyAuthentication);

  const isSupported =
    typeof window !== "undefined" &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function";

  const register = useCallback(async (nickname?: string) => {
    setBusy(true);
    setError(null);
    try {
      if (!isSupported) throw new Error("Biometric authentication is not supported on this device.");
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!available) throw new Error("No biometric authenticator found.");
      const options = await opts();
      const response = await startRegistration({ optionsJSON: options as never });
      const result = await verifyReg({ data: { response, nickname } });
      return result.verified;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Biometric registration failed";
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [isSupported, opts, verifyReg]);

  const authenticate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (!isSupported) throw new Error("Biometric authentication is not available.");
      const options = await authOpts();
      const response = await startAuthentication({ optionsJSON: options as never });
      const result = await verifyAuth({ data: { response } });
      return result.verified;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Biometric verification failed";
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [isSupported, authOpts, verifyAuth]);

  return { register, authenticate, busy, error, isSupported };
}
