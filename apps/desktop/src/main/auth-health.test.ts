import { describe, expect, it } from "vitest";
import {
  accessTokenFresh,
  claudeOauthHealth,
  signInRefreshable,
  signInUsable,
} from "./auth-health.js";

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

describe("signInRefreshable (ADR 0227)", () => {
  it("holds for a Claude sign-in with a live refresh token, its access token expired or not", () => {
    for (const expiresAt of [NOW - 6 * 60_000, NOW + 60_000])
      expect(
        signInRefreshable({
          harness: "claude-code",
          raw: creds({
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt,
            refreshTokenExpiresAt: NOW + 4 * 86_400_000,
          }),
          now: NOW,
        }),
      ).toBe(true);
  });

  it("fails for a Claude sign-in whose refresh token expired, is gone, or is absent", () => {
    expect(
      signInRefreshable({
        harness: "claude-code",
        raw: creds({
          accessToken: "access",
          refreshToken: "refresh",
          refreshTokenExpiresAt: NOW - 1,
        }),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      signInRefreshable({
        harness: "claude-code",
        raw: creds({ accessToken: "access" }),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      signInRefreshable({ harness: "claude-code", raw: null, now: NOW }),
    ).toBe(false);
    expect(
      signInRefreshable({ harness: "claude-code", raw: "garbage", now: NOW }),
    ).toBe(false);
  });

  it("holds for a Codex ChatGPT sign-in with a refresh token, never for a key", () => {
    expect(
      signInRefreshable({
        harness: "codex",
        raw: JSON.stringify({
          OPENAI_API_KEY: null,
          tokens: { access_token: "a", refresh_token: "r" },
        }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      signInRefreshable({
        harness: "codex",
        raw: JSON.stringify({ OPENAI_API_KEY: "key" }),
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("signInUsable", () => {
  it("is Claude's health, and a Codex key or sign-in", () => {
    expect(
      signInUsable({
        harness: "claude-code",
        raw: creds({ accessToken: "x", refreshTokenExpiresAt: NOW + 1 }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      signInUsable({
        harness: "claude-code",
        raw: creds({ accessToken: "x", refreshTokenExpiresAt: NOW - 1 }),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      signInUsable({
        harness: "codex",
        raw: JSON.stringify({ OPENAI_API_KEY: "key" }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      signInUsable({ harness: "codex", raw: JSON.stringify({}), now: NOW }),
    ).toBe(false);
  });
});

describe("accessTokenFresh (ADR 0227)", () => {
  const jwt = (claims: Record<string, unknown>) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

  it("holds for a Claude access token well before its expiry", () => {
    const fresh = (expiresAt: unknown) =>
      accessTokenFresh({
        harness: "claude-code",
        raw: creds({ accessToken: "access", expiresAt }),
        now: NOW,
      });
    expect(fresh(NOW + 8 * 3_600_000)).toBe(true);
    // Near its expiry the CLI refreshes it first, which is what failed.
    expect(fresh(NOW + 60_000)).toBe(false);
    expect(fresh(NOW - 1)).toBe(false);
    expect(fresh(undefined)).toBe(false);
    expect(fresh("soon")).toBe(false);
  });

  it("reads a Codex sign-in's access token expiry, never a key", () => {
    const fresh = (raw: unknown) =>
      accessTokenFresh({
        harness: "codex",
        raw: JSON.stringify(raw),
        now: NOW,
      });
    expect(
      fresh({ tokens: { access_token: jwt({ exp: NOW / 1000 + 3_600 }) } }),
    ).toBe(true);
    expect(
      fresh({ tokens: { access_token: jwt({ exp: NOW / 1000 - 60 }) } }),
    ).toBe(false);
    expect(fresh({ tokens: { access_token: "opaque" } })).toBe(false);
    expect(fresh({ OPENAI_API_KEY: "key" })).toBe(false);
    expect(
      accessTokenFresh({ harness: "codex", raw: "garbage", now: NOW }),
    ).toBe(false);
  });
});
