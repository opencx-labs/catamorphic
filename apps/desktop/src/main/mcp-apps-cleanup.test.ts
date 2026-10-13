import type { ConnectedMcpServer } from "@catamorphic/mcp";
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<ConnectedMcpServer>>(),
}));
vi.mock("@catamorphic/mcp", () => ({
  connectMcpServer: fake.connect,
  uiResourceUri: () => undefined,
  // A lost connection reads "connection lost"; anything else is the server's.
  mcpConnectionLost: (error: unknown) =>
    error instanceof Error && error.message === "connection lost",
}));
vi.mock("electron", () => ({ safeStorage: {} }));

import type { ConnectionsStore } from "./connections-store.js";
import { McpAppsService } from "./mcp-apps.js";

describe("MCP app profile cleanup", () => {
  it("unsubscribes and closes connections that finish opening after profile removal", async () => {
    let connected: ((server: ConnectedMcpServer) => void) | undefined;
    fake.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = resolve;
        }),
    );
    const unsubscribe = vi.fn();
    const store = {
      onChanged: () => unsubscribe,
      list: () => [
        {
          id: "connection",
          name: "test",
          transport: "stdio",
          command: "mock-only",
          enabled: true,
          source: { kind: "manual" },
        },
      ],
    } as unknown as ConnectionsStore;
    const service = new McpAppsService({ connectionsFor: () => store });
    const tools = service.uiTools("profile");
    const removing = service.releaseProfile("profile");
    expect(unsubscribe).toHaveBeenCalledOnce();
    const close = vi.fn(async () => {});
    connected?.({ tools: [], close } as unknown as ConnectedMcpServer);
    await Promise.all([tools, removing]);
    expect(close).toHaveBeenCalledOnce();
    expect(Reflect.get(service, "pool").size).toBe(0);
    expect(Reflect.get(service, "watchedProfiles").size).toBe(0);
    await service.dispose();
  });
});

describe("MCP connection pool after a failed call", () => {
  const store = {
    onChanged: () => () => {},
    list: () => [
      {
        id: "connection",
        name: "probe",
        transport: "stdio",
        command: "mock-only",
        enabled: true,
        source: { kind: "manual" },
      },
    ],
  } as unknown as ConnectionsStore;
  const client = (failure: Error) => {
    const close = vi.fn(async () => {});
    return {
      close,
      server: {
        tools: [],
        close,
        callToolRaw: vi.fn(async () => {
          throw failure;
        }),
      } as unknown as ConnectedMcpServer,
    };
  };

  it("drops a client whose connection was lost once, and the next use reconnects", async () => {
    const dead = client(new Error("connection lost"));
    const fresh = client(new Error("unused"));
    fake.connect
      .mockReset()
      .mockResolvedValueOnce(dead.server)
      .mockResolvedValueOnce(fresh.server);
    const service = new McpAppsService({ connectionsFor: () => store });
    const calls = [1, 2].map(() =>
      service.callTool("profile", "probe/a", "a", {}).catch((error) => error),
    );
    await Promise.all(calls);
    expect(dead.close).toHaveBeenCalledOnce();
    // Both calls failed on the dead client; only one retired it.
    await service.tools("profile", "probe");
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fresh.close).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("keeps the client when the server answered with an error", async () => {
    const answered = client(new Error("Invalid arguments"));
    fake.connect.mockReset().mockResolvedValue(answered.server);
    const service = new McpAppsService({ connectionsFor: () => store });
    await expect(
      service.callTool("profile", "probe/a", "a", {}),
    ).rejects.toThrow("Invalid arguments");
    await service.tools("profile", "probe");
    expect(answered.close).not.toHaveBeenCalled();
    expect(fake.connect).toHaveBeenCalledOnce();
    await service.dispose();
  });
});
