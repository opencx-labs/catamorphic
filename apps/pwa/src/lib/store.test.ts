import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realCrypto = globalThis.crypto;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.stubGlobal("crypto", realCrypto);
  vi.restoreAllMocks();
});

describe("PWA state on a local HTTP origin", () => {
  it("creates its initial profile without the secure-context randomUUID API", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });

    const { getState } = await import("./store.js");

    expect(getState().profiles[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("stores a remote locator with refreshable OAuth credentials", async () => {
    const store = await import("./store.js");
    const addRemoteConnection = (
      store as typeof store & {
        addRemoteConnection?: (input: {
          profileId: string;
          link: {
            serverUrl: string;
            remoteProjectId: string;
            remoteProjectName: string;
          };
          credentials: {
            clientId: string;
            accessToken: string;
            refreshToken: string;
            accessTokenExpiresAt: string;
            tokenEndpoint: string;
            scope: string;
          };
        }) => { id: string };
      }
    ).addRemoteConnection;
    expect(addRemoteConnection).toBeTypeOf("function");
    if (!addRemoteConnection) return;
    const profile = store.activeProfile(store.getState());

    const connection = addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: "https://brain.acme.dev/api",
        remoteProjectId: "project-1",
        remoteProjectName: "Acme Brain",
      },
      credentials: {
        clientId: "pwa-client",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        accessTokenExpiresAt: "2026-08-26T12:00:00.000Z",
        tokenEndpoint: "https://brain.acme.dev/api/auth/mcp/token",
        scope: "openid offline_access",
      },
    });

    expect(store.connectionById(store.getState(), connection.id)).toMatchObject(
      {
        kind: "remote",
        serverUrl: "https://brain.acme.dev/api",
        projectId: "project-1",
        credentials: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
      },
    );
  });

  it("keeps a paired desktop device credential separate from remote OAuth", async () => {
    const store = await import("./store.js");
    const addDeviceConnection = (
      store as typeof store & {
        addDeviceConnection?: (input: {
          profileId: string;
          serverUrl: string;
          name: string;
          accessToken: string;
        }) => { id: string };
      }
    ).addDeviceConnection;
    expect(addDeviceConnection).toBeTypeOf("function");
    if (!addDeviceConnection) return;
    const profile = store.activeProfile(store.getState());

    const connection = addDeviceConnection({
      profileId: profile.id,
      serverUrl: "http://192.168.1.71:4756/api",
      name: "Tabaza's MacBook",
      accessToken: "device-token",
    });

    expect(store.connectionById(store.getState(), connection.id)).toMatchObject(
      {
        kind: "device",
        projectId: "",
        credentials: { accessToken: "device-token" },
      },
    );
  });

  it("does not load the removed version-one bearer-token store", async () => {
    localStorage.setItem(
      "catamorphic-pwa.v1",
      JSON.stringify({
        profiles: [
          {
            id: "old-profile",
            name: "Old",
            color: "#f95225",
            connections: [
              {
                id: "old-connection",
                serverUrl: "https://brain.acme.dev/api",
                token: "legacy-secret",
                projectId: "project-1",
              },
            ],
          },
        ],
        activeProfileId: "old-profile",
      }),
    );

    const store = await import("./store.js");

    expect(store.getState().profiles).toHaveLength(1);
    expect(store.activeProfile(store.getState()).connections).toEqual([]);
  });
});
