// Pure helpers shared by the Connect Account form and its tests.
// Keeping validation here guarantees the submitted payload and the validated
// object are literally the same value — no key drift between the MT inputs
// (login / password / server) and the broker registry credential fields.
import type { BrokerDescriptor, CredentialField } from "./brokerRegistry";

export function buildCredentialValues(input: {
  creds: Record<string, string>;
  accountNumber: string;
  server: string;
  isMt: boolean;
}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.creds)) {
    if (typeof v === "string" && v.trim()) base[k] = v.trim();
  }
  if (input.isMt) {
    const login = (input.accountNumber || input.creds.login || "").trim();
    const server = (input.server || input.creds.server || "").trim();
    if (login) base.login = login;
    if (server) base.server = server;
  }
  return base;
}

/** Returns the first required credential field that has no value, or null. */
export function findMissingCredential(
  broker: Pick<BrokerDescriptor, "authMethod" | "credentialFields">,
  values: Record<string, string>,
): CredentialField | null {
  if (broker.authMethod === "paper" || broker.authMethod === "oauth") return null;
  const fields = broker.credentialFields ?? [];
  return fields.find(f => !f.optional && !(values[f.key] ?? "").trim()) ?? null;
}
