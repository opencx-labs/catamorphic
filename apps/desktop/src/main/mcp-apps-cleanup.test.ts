import type { ConnectedMcpServer } from "@catamorphic/mcp";
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<ConnectedMcpServer>>(),
}));
vi.mock("@catamorphic/mcp", () => ({
  connectMcpServer: fake.connect,
  uiResourceUri: () => undefined,
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
