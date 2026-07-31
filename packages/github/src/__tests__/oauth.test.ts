import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  isTokenStale,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
} from "../oauth.js";
import { GithubAuthError } from "../types.js";

const APP = { clientId: "Iv1_test" };
const NOW = 1_750_000_000_000;

function fetchReturning(payload: unknown, capture?: { body?: string }) {
  return (async (_url: unknown, init?: RequestInit) => {
    if (capture) capture.body = String(init?.body);
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

describe("requestDeviceCode", () => {
  it("maps the grant fields", async () => {
    const grant = await requestDeviceCode(APP, {
      fetch: fetchReturning({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 899,
        interval: 5,
      }),
    });
    expect(grant.userCode).toBe("ABCD-1234");
    expect(grant.deviceCode).toBe("dc");
    expect(grant.interval).toBe(5);
  });

  it("throws GithubAuthError on error payloads", async () => {
    await expect(
      requestDeviceCode(APP, {
        fetch: fetchReturning({ error: "device_flow_disabled" }),
      }),
    ).rejects.toThrow(GithubAuthError);
  });
});

describe("pollDeviceToken", () => {
  it("returns null while authorization is pending", async () => {
    const result = await pollDeviceToken(APP, "dc", {
      fetch: fetchReturning({ error: "authorization_pending" }),
    });
    expect(result.tokens).toBeNull();
  });

  it("returns retryAfter on slow_down", async () => {
    const result = await pollDeviceToken(APP, "dc", {
      fetch: fetchReturning({ error: "slow_down", interval: 10 }),
    });
    expect(result).toEqual({ tokens: null, retryAfter: 10 });
  });

  it("maps a successful token response with expiry", async () => {
    const result = await pollDeviceToken(APP, "dc", {
      now: NOW,
      fetch: fetchReturning({
        access_token: "ghu_tok",
        expires_in: 28800,
        refresh_token: "ghr_ref",
        refresh_token_expires_in: 15897600,
      }),
    });
    expect(result.tokens).toEqual({
      accessToken: "ghu_tok",
      expiresAt: NOW + 28800 * 1000,
      refreshToken: "ghr_ref",
      refreshTokenExpiresAt: NOW + 15897600 * 1000,
    });
  });

  it("throws on terminal errors like access_denied", async () => {
    await expect(
      pollDeviceToken(APP, "dc", {
        fetch: fetchReturning({ error: "access_denied" }),
      }),
    ).rejects.toThrow(GithubAuthError);
  });
});

describe("exchangeCode", () => {
  it("requires a client secret", async () => {
    await expect(
      exchangeCode(APP, { code: "abc" }, { fetch: fetchReturning({}) }),
    ).rejects.toThrow(/client secret/);
  });

  it("posts code + secret and maps tokens", async () => {
    const capture: { body?: string } = {};
    const tokens = await exchangeCode(
      { ...APP, clientSecret: "s3cret" },
      { code: "abc" },
      { now: NOW, fetch: fetchReturning({ access_token: "ghu_x" }, capture) },
    );
    expect(tokens.accessToken).toBe("ghu_x");
    expect(tokens.expiresAt).toBeNull();
    expect(capture.body).toContain("client_secret=s3cret");
    expect(capture.body).toContain("code=abc");
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh grant without requiring a secret", async () => {
    const capture: { body?: string } = {};
    const tokens = await refreshAccessToken(APP, "ghr_old", {
      now: NOW,
      fetch: fetchReturning(
        {
          access_token: "ghu_new",
          expires_in: 28800,
          refresh_token: "ghr_new",
        },
        capture,
      ),
    });
    expect(tokens.accessToken).toBe("ghu_new");
    expect(tokens.refreshToken).toBe("ghr_new");
    expect(capture.body).toContain("grant_type=refresh_token");
    expect(capture.body).not.toContain("client_secret");
  });
});

describe("isTokenStale", () => {
  it("is false for non-expiring tokens", () => {
    expect(isTokenStale({ expiresAt: null }, NOW)).toBe(false);
  });

  it("is true within the skew window", () => {
    expect(isTokenStale({ expiresAt: NOW + 30_000 }, NOW)).toBe(true);
    expect(isTokenStale({ expiresAt: NOW + 120_000 }, NOW)).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes client id, redirect uri and state", () => {
    const url = new URL(
      buildAuthorizeUrl(APP, {
        redirectUri: "https://host.example/callback",
        state: "xyz",
      }),
    );
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1_test");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://host.example/callback",
    );
    expect(url.searchParams.get("state")).toBe("xyz");
  });
});
