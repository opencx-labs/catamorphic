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
