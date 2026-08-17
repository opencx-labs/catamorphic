import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeMcpServer } from "../client.js";
import {
  authorizeMcpServer,
  bearerHeaders,
  createOAuthProvider,
  isAuthorizationError,
  type McpOAuthState,
  type McpOAuthStore,
  refreshMcpTokens,
  tokensExpiring,
} from "../oauth.js";
import {
  FAKE_ACCESS_TOKEN as ACCESS,
  type FakeOAuthMcp,
  FAKE_REFRESHED_TOKEN as REFRESHED,
  startFakeOAuthMcp,
} from "./fake-oauth-server.js";

/**
 * The whole authorization dance against the in-process fake (see
 * fake-oauth-server.ts). `openUrl` plays the browser: it follows the
 * consent redirect to our loopback callback.
 */

let fake: FakeOAuthMcp;
let base = "";

const memoryStore = (): McpOAuthStore & { state: McpOAuthState } => {
  const holder = { state: {} as McpOAuthState };
  return {
    get state() {
      return holder.state;
    },
    load: () => structuredClone(holder.state),
    save: (state) => {
      holder.state = structuredClone(state);
    },
  };
};

beforeAll(async () => {
  fake = await startFakeOAuthMcp();
  base = fake.base;
});

afterAll(() => {
  fake.close();
});

describe("authorizeMcpServer", () => {
  it("probes as needs-auth before authorization", async () => {
    const probe = await probeMcpServer({
      transport: "http",
      url: `${base}/mcp`,
    });
    expect(probe.ok).toBe(false);
    expect(isAuthorizationError(probe.error)).toBe(true);
  });

  it("registers, consents via the opened URL, exchanges the code, and lands tokens", async () => {
    const store = memoryStore();
    fake.tokenRequests.length = 0;
    fake.registrations.length = 0;
    const opened: string[] = [];
    let served: string | null = null;
    const result = await authorizeMcpServer(
      { transport: "http", url: `${base}/mcp` },
      {
        store,
        openUrl: async (url) => {
          opened.push(url);
          // The "browser": hit the consent page, follow its redirect to
          // the loopback callback.
          const consent = await fetch(url, { redirect: "manual" });
          const location = consent.headers.get("location");
          expect(location).toBeTruthy();
          const callback = await fetch(location as string);
          expect(callback.status).toBe(200);
          expect(await callback.text()).toContain("Connected");
        },
        onCallbackServed: (origin) => {
          served = origin;
        },
        timeoutMs: 20_000,
      },
    );
    expect(result).toEqual({ toolCount: 1, alreadyAuthorized: false });
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0] as string).pathname).toBe("/authorize");
    // The consent URL asks for the redirect we listened on (loopback, random port).
    const redirectUri = new URL(opened[0] as string).searchParams.get(
      "redirect_uri",
    );
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(served).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Registration carried our redirect; token exchange used PKCE.
    expect(fake.registrations).toHaveLength(1);
    expect(fake.tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(fake.tokenRequests[0]?.get("code_verifier")).toBeTruthy();
    // Tokens on file, verifier gone, bearer header ready for the harnesses.
    expect(store.state.tokens?.access_token).toBe(ACCESS);
    expect(store.state.tokens?.refresh_token).toBe("refresh-1");
    expect(store.state.codeVerifier).toBeUndefined();
    expect(store.state.tokensObtainedAt).toBeTypeOf("number");
    expect(bearerHeaders(store.state)).toEqual({
      Authorization: `Bearer ${ACCESS}`,
    });
    // And the server is happy with that header.
    const probe = await probeMcpServer({
      transport: "http",
      url: `${base}/mcp`,
      headers: bearerHeaders(store.state),
    });
    expect(probe.ok).toBe(true);
    expect(probe.toolCount).toBe(1);

    // Refresh: not needed while fresh; forced/expiring goes through the
    // refresh grant without a browser.
    expect(tokensExpiring(store.state)).toBe(false);
    expect(
      await refreshMcpTokens({ transport: "http", url: `${base}/mcp` }, store),
    ).toBe(true);
    expect(store.state.tokens?.access_token).toBe(ACCESS);
    store.save({ ...store.load(), tokensObtainedAt: Date.now() - 3600_000 });
    expect(tokensExpiring(store.state)).toBe(true);
    expect(
      await refreshMcpTokens({ transport: "http", url: `${base}/mcp` }, store),
    ).toBe(true);
    expect(store.state.tokens?.access_token).toBe(REFRESHED);
    expect(tokensExpiring(store.state)).toBe(false);
  }, 30_000);

  it("a pre-registered client skips registration and listens on its fixed port", async () => {
    const store = memoryStore();
    fake.registrations.length = 0;
    // A free port, found the boring way.
    const probe = await import("node:net").then(
      (net) =>
        new Promise<number>((resolve) => {
          const server = net.createServer();
          server.listen(0, () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
          });
        }),
    );
    let redirectUri: string | null = null;
    const result = await authorizeMcpServer(
      { transport: "http", url: `${base}/mcp` },
      {
        store,
        client: { clientId: "pre-registered-1", callbackPort: probe },
        openUrl: async (url) => {
          redirectUri = new URL(url).searchParams.get("redirect_uri");
          expect(new URL(url).searchParams.get("client_id")).toBe(
            "pre-registered-1",
          );
          const consent = await fetch(url, { redirect: "manual" });
          await fetch(consent.headers.get("location") as string);
        },
        timeoutMs: 20_000,
      },
    );
    expect(result.toolCount).toBe(1);
    expect(fake.registrations).toHaveLength(0);
    expect(redirectUri).toBe(`http://localhost:${probe}/callback`);
    expect(store.state.tokens?.access_token).toBe(ACCESS);
  }, 30_000);

  it("a provider without a redirect hook refuses to redirect (no surprise browser tabs)", async () => {
    const store = memoryStore();
    const provider = createOAuthProvider({
      store,
      redirectUrl: "http://127.0.0.1:1/callback",
    });
    await expect(
      provider.redirectToAuthorization(
        new URL("https://example.com/authorize"),
      ),
    ).rejects.toThrow(/needs authorization/);
    expect(
      await refreshMcpTokens({ transport: "http", url: `${base}/mcp` }, store),
    ).toBe(false);
  });
});

describe("isAuthorizationError", () => {
  it("recognizes 401s and unauthorized messages, not other failures", () => {
    expect(isAuthorizationError(new Error("HTTP 401: Unauthorized"))).toBe(
      true,
    );
    expect(isAuthorizationError("Authentication failed for https://x")).toBe(
      true,
    );
    expect(isAuthorizationError(new Error("fetch failed"))).toBe(false);
    expect(isAuthorizationError(new Error("HTTP 500"))).toBe(false);
  });
});
