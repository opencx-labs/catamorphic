import { describe, expect, it } from "vitest";
import {
  DESKTOP_API_TOKEN_HEADER,
  localApiRefusal,
  newDesktopApiToken,
  previewRequestRefusal,
} from "./local-api-guard.js";

const port = 41234;
const token = newDesktopApiToken();
const host = `127.0.0.1:${port}`;

describe("the embedded API's callers", () => {
  const refusal = (input: {
    method?: string;
    url?: string;
    headers: Record<string, string>;
  }) =>
    localApiRefusal({
      method: input.method ?? "POST",
      url: input.url ?? "/api/projects",
      headers: input.headers,
      port,
      token,
    });

  it("lets the desktop's own windows through with the run's token", () => {
    expect(
      refusal({
        headers: {
          host,
          origin: "null",
          "sec-fetch-site": "cross-site",
          [DESKTOP_API_TOKEN_HEADER]: token,
        },
      }),
    ).toBeUndefined();
  });

  it("lets local programs that are not browsers through", () => {
    expect(refusal({ headers: { host } })).toBeUndefined();
    expect(refusal({ headers: { host: `localhost:${port}` } })).toBeUndefined();
  });

  it.each([
    ["a page's fetch", { origin: "https://evil.example" }],
    ["a sandboxed frame", { origin: "null" }],
    ["a page's image or form", { "sec-fetch-site": "cross-site" }],
    ["a typed address", { "sec-fetch-site": "none" }],
  ])("refuses %s", (_name, browser) => {
    expect(refusal({ headers: { host, ...browser } })).toBe(
      "Web pages cannot use the desktop's API",
    );
  });

  it("refuses a wrong token like none", () => {
    expect(
      refusal({
        headers: {
          host,
          origin: "https://evil.example",
          [DESKTOP_API_TOKEN_HEADER]: `${token.slice(0, -1)}x`,
        },
      }),
    ).toBe("Web pages cannot use the desktop's API");
  });

  it("refuses a host other than its loopback address, token or not", () => {
    expect(
      refusal({
        headers: {
          host: `rebound.example:${port}`,
          [DESKTOP_API_TOKEN_HEADER]: token,
        },
      }),
    ).toBe("The desktop's API answers only on its loopback address");
    expect(refusal({ headers: { host: "127.0.0.1:1" } })).toBeDefined();
  });

  it("answers preflights and a connection's return to the person's browser", () => {
    expect(
      refusal({
        method: "OPTIONS",
        headers: { host, origin: "https://evil.example" },
      }),
    ).toBeUndefined();
    expect(
      refusal({
        method: "GET",
        url: "/api/connection-authorizations/callback?state=abc&code=def",
        headers: { host, "sec-fetch-site": "cross-site" },
      }),
    ).toBeUndefined();
    expect(
      refusal({
        method: "POST",
        url: "/api/connection-authorizations/callback?state=abc",
        headers: { host, "sec-fetch-site": "cross-site" },
      }),
    ).toBeDefined();
  });
});

describe("a preview's callers (ADR 0208)", () => {
  const own = `http://127.0.0.1:${port}`;
  it("serves its own pages, their resources, and a typed address", () => {
    for (const headers of [
      { host },
      { host, "sec-fetch-site": "none" },
      { host, "sec-fetch-site": "same-origin", origin: own },
    ])
      expect(previewRequestRefusal({ headers, port })).toBeUndefined();
  });

  it("gives another site nothing", () => {
    for (const headers of [
      { host, origin: "https://evil.example" },
      { host, "sec-fetch-site": "cross-site" },
      { host, "sec-fetch-site": "same-site" },
      { host: `rebound.example:${port}` },
    ])
      expect(previewRequestRefusal({ headers, port })).toBeDefined();
  });
});
