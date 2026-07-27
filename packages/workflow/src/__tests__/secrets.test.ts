import { afterEach, describe, expect, it } from "vitest";
import { defineSecrets, MissingSecretError } from "../secrets.js";

describe("defineSecrets", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reads declared secrets from the environment", () => {
    process.env.STRIPE_API_KEY = "sk_test_123";
    const secrets = defineSecrets({ STRIPE_API_KEY: {} });

    expect(secrets.STRIPE_API_KEY).toBe("sk_test_123");
  });

  it("throws a named error rather than yielding undefined when unset", () => {
    process.env.STRIPE_API_KEY = undefined;
    const secrets = defineSecrets({ STRIPE_API_KEY: {} });

    expect(() => secrets.STRIPE_API_KEY).toThrow(MissingSecretError);
    expect(() => secrets.STRIPE_API_KEY).toThrow(/STRIPE_API_KEY/);
  });

  it("treats an empty value as unset", () => {
    process.env.STRIPE_API_KEY = "";
    const secrets = defineSecrets({ STRIPE_API_KEY: {} });

    expect(() => secrets.STRIPE_API_KEY).toThrow(MissingSecretError);
  });

  it("rejects names that are not env-var style", () => {
    expect(() => defineSecrets({ stripeApiKey: {} })).toThrow(
      /SCREAMING_SNAKE_CASE/,
    );
  });

  it("rejects the reserved prefix", () => {
    expect(() => defineSecrets({ CATAMORPHIC_TOKEN: {} })).toThrow(/reserved/);
  });
});

describe("defineSecrets accessor scope", () => {
  it("does not expose environment variables that were not declared", () => {
    process.env.UNDECLARED_TOKEN = "should-not-be-reachable";
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-be-reachable";
    const secrets = defineSecrets({ STRIPE_API_KEY: {} });

    // The accessor is exactly as wide as the declaration, so a typo or a
    // deliberate reach cannot turn it into a general process.env reader.
    expect(
      (secrets as unknown as Record<string, string | undefined>)
        .UNDECLARED_TOKEN,
    ).toBeUndefined();
    expect(
      (secrets as unknown as Record<string, string | undefined>)
        .AWS_SECRET_ACCESS_KEY,
    ).toBeUndefined();
  });

  it("does not leak inherited Object properties as secrets", () => {
    const secrets = defineSecrets({ STRIPE_API_KEY: {} });
    // `in` would say true for these; the accessor must not.
    expect(
      (secrets as unknown as Record<string, unknown>).toString,
    ).toBeUndefined();
    expect(
      (secrets as unknown as Record<string, unknown>).constructor,
    ).toBeUndefined();
  });

  it("enumerates only declared names", () => {
    process.env.STRIPE_API_KEY = "sk_live_1";
    const secrets = defineSecrets({ STRIPE_API_KEY: {}, OTHER_KEY: {} });
    expect(Object.keys(secrets).sort()).toEqual([
      "OTHER_KEY",
      "STRIPE_API_KEY",
    ]);
  });
});
