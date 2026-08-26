import { describe, expect, it } from "vitest";
import { applyPairing, type PairingClaim } from "./pairing.js";
import { activeProfile, getState } from "./store.js";

const claim = (context?: PairingClaim["context"]): PairingClaim => ({
  version: 1,
  name: "Tabaza's MacBook",
  server: "http://192.168.1.71:4756/api/",
  token: "device-token",
  remotes: [
    {
      server: "https://brain.acme.dev/api",
      project: "p-remote",
      name: "Acme Brain",
      localProjectId: "p-local",
    },
  ],
  context,
});

describe("applyPairing", () => {
  it("stores the desktop connection AND the remote links, lands on projects", () => {
    const route = applyPairing(getState(), claim());
    expect(route).toEqual({ kind: "projects" });
    const connections = activeProfile(getState()).connections;
    const desktop = connections.find(
      (c) => c.serverUrl === "http://192.168.1.71:4756/api",
    );
    expect(desktop).toMatchObject({
      kind: "device",
      credentials: { accessToken: "device-token" },
    });
    const remote = connections.find(
      (c) => c.serverUrl === "https://brain.acme.dev/api",
    );
    expect(remote?.projectId).toBe("p-remote");
    expect(remote?.projectName).toBe("Acme Brain");
    expect(remote).toMatchObject({ kind: "remote" });
    expect(
      remote && "credentials" in remote ? remote.credentials : undefined,
    ).toBeUndefined();
    // The failover hint: desktop project → its remote mirror.
    expect(desktop?.mirrors).toEqual({
      "p-local": {
        serverUrl: "https://brain.acme.dev/api",
        projectId: "p-remote",
        name: "Acme Brain",
      },
    });
  });

  it("deep-links into the chat the desktop had focused", () => {
    const route = applyPairing(
      getState(),
      claim({ projectId: "p-1", sessionId: "s-1" }),
    );
    expect(route.kind).toBe("chat");
    if (route.kind !== "chat") return;
    expect(route.projectId).toBe("p-1");
    expect(route.sessionId).toBe("s-1");
    const connection = activeProfile(getState()).connections.find(
      (c) => c.id === route.connectionId,
    );
    expect(connection?.serverUrl).toBe("http://192.168.1.71:4756/api");
  });
});
