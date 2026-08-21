import { describe, expect, it } from "vitest";
import { claudeOauthHealth } from "./auth-health.js";

const NOW = 1_800_000_000_000;

const creds = (oauth: Record<string, unknown>) =>
  JSON.stringify({ claudeAiOauth: oauth });

describe("claudeOauthHealth", () => {
  it("is ok while the refresh token is alive (even with an expired access token)", () => {
    expect(
      claudeOauthHealth(
        creds({
          accessToken: "sk-ant-oat01-x",
          expiresAt: NOW - 1000,
          refreshTokenExpiresAt: NOW + 86_400_000,
        }),
        NOW,
      ),
    ).toBe("ok");
    // The wild shape: refreshTokenExpiresAt as a numeric string.
    expect(
      claudeOauthHealth(
        creds({
          accessToken: "sk-ant-oat01-x",
          refreshTokenExpiresAt: String(NOW + 86_400_000),
        }),
        NOW,
      ),
    ).toBe("ok");
    // No refresh expiry recorded: nothing knowably wrong.
    expect(claudeOauthHealth(creds({ accessToken: "x" }), NOW)).toBe("ok");
  });

  it("is expired once the refresh token is past its expiry", () => {
    expect(
      claudeOauthHealth(
        creds({ accessToken: "x", refreshTokenExpiresAt: NOW - 1 }),
        NOW,
      ),
    ).toBe("expired");
  });

  it("is missing without credentials or with garbage", () => {
    expect(claudeOauthHealth(null, NOW)).toBe("missing");
    expect(claudeOauthHealth("not json", NOW)).toBe("missing");
    expect(claudeOauthHealth(creds({}), NOW)).toBe("missing");
  });
});
