import { describe, it, expect } from "vitest";
import { buildCredentialValues, findMissingCredential } from "@/lib/connectors/credentialForm";
import { getBroker } from "@/lib/connectors/brokerRegistry";

describe("MT5 connection form validation", () => {
  it("accepts a filled Octa MT5 form (login + password + server)", () => {
    const broker = getBroker("octa")!;
    const values = buildCredentialValues({
      creds: { password: "secret123" },
      accountNumber: "63083236",
      server: "OctaFX-Real",
      isMt: true,
    });
    expect(values).toMatchObject({ login: "63083236", password: "secret123", server: "OctaFX-Real" });
    expect(findMissingCredential(broker, values)).toBeNull();
  });

  it("flags a missing MT login", () => {
    const broker = getBroker("mt5")!;
    const values = buildCredentialValues({
      creds: { password: "secret123" },
      accountNumber: "  ",
      server: "ICMarketsSC-Live22",
      isMt: true,
    });
    expect(findMissingCredential(broker, values)?.key).toBe("login");
  });

  it("does not require the optional MetaApi advanced fields", () => {
    const broker = getBroker("exness")!;
    const values = buildCredentialValues({
      creds: { password: "pw" },
      accountNumber: "123456",
      server: "Exness-Real",
      isMt: true,
    });
    expect(findMissingCredential(broker, values)).toBeNull();
  });

  it("still validates api_key brokers by their own field keys", () => {
    const broker = getBroker("bybit")!;
    expect(findMissingCredential(broker, {})).not.toBeNull();
  });
});
