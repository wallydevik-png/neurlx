import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const RP_NAME = "Helix Trading";
const ORIGIN = typeof process !== "undefined" && process.env.VITE_SITE_URL
  ? process.env.VITE_SITE_URL
  : "http://localhost:8080";

const registrationOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const existing = await supabase
      .from("webauthn_credentials")
      .select("credential_id")
      .eq("user_id", userId);
    const excludeCredentials = (existing.data ?? []).map((c) => ({
      id: c.credential_id,
      type: "public-key" as const,
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: new URL(ORIGIN).hostname,
      userID: new TextEncoder().encode(userId),
      userName: userId,
      challenge: crypto.randomUUID(),
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        authenticatorAttachment: "platform",
      },
    });

    const { error } = await supabase.from("webauthn_challenges").insert({
      user_id: userId,
      challenge: options.challenge,
      purpose: "registration",
    });
    if (error) throw new Error(error.message);

    return options;
  });

const verifyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      response: z.record(z.any()),
      nickname: z.string().max(50).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const challengeRow = await supabase
      .from("webauthn_challenges")
      .select("id,challenge")
      .eq("user_id", userId)
      .eq("purpose", "registration")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!challengeRow.data) throw new Error("No registration challenge found.");

    const verification = await verifyRegistrationResponse({
      response: data.response as never,
      expectedChallenge: challengeRow.data.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: new URL(ORIGIN).hostname,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("WebAuthn registration verification failed.");
    }

    const info = verification.registrationInfo;
    const { error: insertError } = await supabase.from("webauthn_credentials").insert({
      user_id: userId,
      credential_id: info.credential.id,
      public_key: Buffer.from(info.credential.publicKey).toString("base64"),
      counter: info.credential.counter,
      device_type: info.credentialDeviceType ?? "unknown",
      backed_up: info.credentialBackedUp ?? false,
      transports: (info.credential.transports ?? []),
      nickname: data.nickname || "Mobile device",
    });
    if (insertError) throw new Error(insertError.message);

    await supabase.from("webauthn_challenges").delete().eq("id", challengeRow.data.id);
    await supabase.from("audit_log").insert({
      user_id: userId,
      action: "webauthn.registered",
      entity: "webauthn_credentials",
      metadata: { credential_id: info.credential.id, device_type: info.credentialDeviceType } as never,
    });
    return { verified: true };
  });

const authenticationOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const credentials = await supabase
      .from("webauthn_credentials")
      .select("credential_id,transports")
      .eq("user_id", userId)
      .eq("is_active", true);

    const allowCredentials = (credentials.data ?? []).map((c) => ({
      id: c.credential_id,
      type: "public-key" as const,
      transports: (c.transports ?? []) as any,
    }));

    const options = await generateAuthenticationOptions({
      rpID: new URL(ORIGIN).hostname,
      allowCredentials,
      challenge: crypto.randomUUID(),
      userVerification: "preferred",
    });

    const { error } = await supabase.from("webauthn_challenges").insert({
      user_id: userId,
      challenge: options.challenge,
      purpose: "authentication",
    });
    if (error) throw new Error(error.message);
    return options;
  });

const verifyAuthentication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ response: z.record(z.any()) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const response = data.response as { id?: string; rawId?: string };
    const credentialId = response.id;
    if (!credentialId) throw new Error("Credential ID missing.");

    const credRow = await supabase
      .from("webauthn_credentials")
      .select("*")
      .eq("user_id", userId)
      .eq("credential_id", credentialId)
      .eq("is_active", true)
      .maybeSingle();
    if (!credRow.data) throw new Error("Credential not recognized.");

    const challengeRow = await supabase
      .from("webauthn_challenges")
      .select("id,challenge")
      .eq("user_id", userId)
      .eq("purpose", "authentication")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!challengeRow.data) throw new Error("No authentication challenge found.");

    const verification = await verifyAuthenticationResponse({
      response: data.response as never,
      expectedChallenge: challengeRow.data.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: new URL(ORIGIN).hostname,
      requireUserVerification: false,
      credential: {
        id: credRow.data.credential_id,
        publicKey: Buffer.from(credRow.data.public_key, "base64"),
        counter: credRow.data.counter,
        transports: credRow.data.transports as any,
      },
    });
    if (!verification.verified) throw new Error("Biometric verification failed.");

    const { error: updError } = await supabase
      .from("webauthn_credentials")
      .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
      .eq("id", credRow.data.id);
    if (updError) throw new Error(updError.message);

    await supabase.from("webauthn_challenges").delete().eq("id", challengeRow.data.id);
    await supabase.from("audit_log").insert({
      user_id: userId,
      action: "webauthn.verified",
      entity: "webauthn_credentials",
      metadata: { credential_id: credentialId },
    });
    return { verified: true };
  });

const listCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("webauthn_credentials")
      .select("id,credential_id,nickname,device_type,backed_up,created_at,last_used_at,is_active")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const removeCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("webauthn_credentials")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    await supabase.from("audit_log").insert({
      user_id: userId,
      action: "webauthn.removed",
      entity: "webauthn_credentials",
      metadata: { id: data.id },
    });
    return { ok: true };
  });

export {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  listCredentials,
  removeCredential,
};
