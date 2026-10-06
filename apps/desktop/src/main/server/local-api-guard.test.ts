import http from "node:http";
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

/** The headers a real request of Node's own `fetch` (undici) arrives with. */
async function nodeFetchHeaders(): Promise<{
  headers: http.IncomingHttpHeaders;
  port: number;
}> {
  let seen: http.IncomingHttpHeaders = {};
  const server = http.createServer((request, response) => {
    seen = request.headers;
    response.end("{}");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const listening = typeof address === "object" && address ? address.port : 0;
  try {
    await fetch(`http://127.0.0.1:${listening}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { headers: seen, port: listening };
}

describe("local programs on Node's fetch", () => {
  it("pass without the token although undici sends Sec-Fetch-Mode", async () => {
    const { headers, port: listening } = await nodeFetchHeaders();
    // What made them look like a browser before.
    expect(headers["sec-fetch-mode"]).toBe("cors");
    expect(headers["sec-fetch-site"]).toBeUndefined();
    expect(
      localApiRefusal({
        method: "POST",
        url: "/api/projects",
        headers,
        port: listening,
        token,
      }),
    ).toBeUndefined();
  });

  it("still refuses what a browser stamps alongside it", () => {
    for (const browser of [
      { "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" },
      { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
      { "sec-fetch-mode": "cors", origin: "https://evil.example" },
    ])
      expect(
        localApiRefusal({
          method: "POST",
          url: "/api/projects",
          headers: { host, ...browser },
          port,
          token,
        }),
      ).toBe("Web pages cannot use the desktop's API");
  });
});

describe("a preview's callers (ADR 0209)", () => {
  const own = "http://p-0123456789abcdef0123.localhost:41234";
  const ownHost = "p-0123456789abcdef0123.localhost:41234";

  it("serves its own pages, their resources, and a typed address", () => {
    for (const headers of [
      { host: ownHost },
      { host: ownHost, "sec-fetch-site": "none" },
      { host: ownHost, "sec-fetch-site": "same-origin", origin: own },
    ])
      expect(previewRequestRefusal({ headers, origin: own })).toBeUndefined();
  });

  it("gives another site nothing, a plain link included", () => {
    for (const headers of [
      { host: ownHost, origin: "https://evil.example" },
      { host: ownHost, "sec-fetch-site": "cross-site" },
      { host: ownHost, "sec-fetch-site": "same-site" },
      // Another preview of this desktop is another site.
      {
        host: ownHost,
        origin: "http://p-ffffffffffffffffffff.localhost:41234",
      },
    ])
      expect(previewRequestRefusal({ headers, origin: own })).toBe(
        "Another site cannot use this preview",
      );
  });

  it("answers only its own host", () => {
    for (const hostHeader of [
      "127.0.0.1:41234",
      "localhost:41234",
      "p-ffffffffffffffffffff.localhost:41234",
      "rebound.example:41234",
    ])
      expect(
        previewRequestRefusal({ headers: { host: hostHeader }, origin: own }),
      ).toBe("A preview answers only on its own address");
  });
});
