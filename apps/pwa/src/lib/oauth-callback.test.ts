import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginRemoteAuthorization, beginServerAuthorization } from "./oauth.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

function fetchForCallback(options: {
  admitted: boolean;
  admitOn?: "join" | "redeem";
  joinable?: boolean;
  admissionCalls?: string[];
}): typeof fetch {
  let admitted = options.admitted;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({
        authorization_servers: ["https://brain.acme.dev"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        authorization_endpoint: "https://brain.acme.dev/api/auth/mcp/authorize",
        token_endpoint: "https://brain.acme.dev/api/auth/mcp/token",
        registration_endpoint: "https://brain.acme.dev/api/auth/mcp/register",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/api/auth/mcp/register") {
      return Response.json({ client_id: "pwa-client" }, { status: 201 });
    }
    if (url.pathname === "/api/auth/mcp/token") {
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/api/admission/projects") {
      return Response.json(
        options.joinable ? [{ id: "project-1", name: "Acme Brain" }] : [],
      );
    }
    if (url.pathname.includes("/admission/")) {
      options.admissionCalls?.push(url.pathname);
      if (
        (options.admitOn === "join" && url.pathname.endsWith("/join")) ||
        (options.admitOn === "redeem" && url.pathname.endsWith("/redeem"))
      ) {
        admitted = true;
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Admission denied" }, { status: 403 });
    }
    if (url.pathname === "/api/me") {
      expect(request.headers.get("authorization")).toBe("Bearer access-token");
      return Response.json({
        identity: { externalUserId: "user-1", root: false },
        projects: admitted
          ? [{ projectId: "project-1", agents: ["assistant"] }]
          : [],
      });
    }
    return new Response(null, { status: 404 });
  };
}

async function prepare(
  fetchImpl: typeof fetch,
  invitationId?: string,
): Promise<string> {
  const started = await beginRemoteAuthorization({
    link: {
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "project-1",
      remoteProjectName: "Acme Brain",
      ...(invitationId ? { invitationId } : {}),
      sessionId: "session-1",
    },
    redirectUri: "https://brain.acme.dev/oauth/callback",
    storage: sessionStorage,
    fetch: fetchImpl,
  });
  return new URL(started.authorizationUrl).searchParams.get("state") ?? "";
}

describe("completeRemoteConnection", () => {
  it("connects every existing membership after signing in at the server host", async () => {
    const fetchImpl = fetchForCallback({ admitted: true });
    const started = await beginServerAuthorization({
      serverUrl: "https://brain.acme.dev/api",
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: fetchImpl,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    const route = await completeRemoteConnection({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
      profileId: profile.id,
      storage: sessionStorage,
      fetch: fetchImpl,
    });

    expect(route).toEqual({ kind: "projects" });
    expect(store.activeProfile(store.getState()).connections).toEqual([
      expect.objectContaining({
        kind: "remote",
        serverUrl: "https://brain.acme.dev/api",
        projectId: "project-1",
        credentials: expect.objectContaining({
          refreshToken: "refresh-token",
        }),
      }),
    ]);
  });

  it("explains when server sign-in succeeds without any memberships", async () => {
    const fetchImpl = fetchForCallback({ admitted: false });
    const started = await beginServerAuthorization({
      serverUrl: "https://brain.acme.dev/api",
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: fetchImpl,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    await expect(
      completeRemoteConnection({
        callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
        profileId: profile.id,
        storage: sessionStorage,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("do not have access to any projects");
  });

  it("joins a project the server makes available after direct sign-in", async () => {
    const admissionCalls: string[] = [];
    const fetchImpl = fetchForCallback({
      admitted: false,
      admitOn: "join",
      joinable: true,
      admissionCalls,
    });
    const started = await beginServerAuthorization({
      serverUrl: "https://brain.acme.dev/api",
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: fetchImpl,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    await completeRemoteConnection({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
      profileId: profile.id,
      storage: sessionStorage,
      fetch: fetchImpl,
    });

    expect(admissionCalls).toEqual(["/api/projects/project-1/admission/join"]);
    expect(store.activeProfile(store.getState()).connections).toHaveLength(1);
  });

  it("stores the connection only after membership is confirmed", async () => {
    const admissionCalls: string[] = [];
    const fetchImpl = fetchForCallback({
      admitted: false,
      admitOn: "join",
      admissionCalls,
    });
    const state = await prepare(fetchImpl);
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    const route = await completeRemoteConnection({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
      profileId: profile.id,
      storage: sessionStorage,
      fetch: fetchImpl,
    });

    expect(route).toMatchObject({
      kind: "chat",
      projectId: "project-1",
      sessionId: "session-1",
    });
    expect(store.activeProfile(store.getState()).connections).toHaveLength(1);
    expect(store.activeProfile(store.getState()).connections[0]).toMatchObject({
      kind: "remote",
      credentials: { refreshToken: "refresh-token" },
    });
    expect(admissionCalls).toEqual(["/api/projects/project-1/admission/join"]);
  });

  it("redeems the credential-free invitation after sign-in", async () => {
    const admissionCalls: string[] = [];
    const fetchImpl = fetchForCallback({
      admitted: false,
      admitOn: "redeem",
      admissionCalls,
    });
    const state = await prepare(fetchImpl, "invite-1");
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    await completeRemoteConnection({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
      profileId: profile.id,
      storage: sessionStorage,
      fetch: fetchImpl,
    });

    expect(admissionCalls).toEqual([
      "/api/projects/project-1/admission/invitations/invite-1/redeem",
    ]);
  });

  it("skips admission when reconnecting an existing member", async () => {
    const admissionCalls: string[] = [];
    const fetchImpl = fetchForCallback({ admitted: true, admissionCalls });
    const state = await prepare(fetchImpl);
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    await completeRemoteConnection({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
      profileId: profile.id,
      storage: sessionStorage,
      fetch: fetchImpl,
    });

    expect(admissionCalls).toEqual([]);
  });

  it("keeps an authenticated but unadmitted user disconnected", async () => {
    const fetchImpl = fetchForCallback({ admitted: false });
    const state = await prepare(fetchImpl);
    const store = await import("./store.js");
    const { completeRemoteConnection } = await import("./oauth-callback.js");
    const profile = store.activeProfile(store.getState());

    await expect(
      completeRemoteConnection({
        callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
        profileId: profile.id,
        storage: sessionStorage,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("do not have access to this project");
    expect(store.activeProfile(store.getState()).connections).toEqual([]);
  });
});
