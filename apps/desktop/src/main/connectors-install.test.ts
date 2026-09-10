import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InstalledPluginInfo } from "@catamorphic/mcp";
import { expect, it, vi } from "vitest";

const { readPlugin } = vi.hoisted(() => ({
  readPlugin: vi.fn<() => Promise<InstalledPluginInfo>>(),
}));

vi.mock("@catamorphic/mcp", () => ({
  DEFAULT_MARKETPLACES: ["example/plugins"],
  fetchMarketplace: async () => [
    {
      name: "example",
      description: "Catalog description",
      version: "1.0",
      marketplace: "example/plugins",
      source: { kind: "git", url: "https://example.com/plugin.git" },
    },
  ],
  installPluginFromSource: async () => {},
  readInstalledPlugin: readPlugin,
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import { ConnectionsStore } from "./connections-store.js";
import { ConnectorsService } from "./connectors.js";

it("refreshes manifest-owned configuration without losing user policy and rejects invalid installs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "connector-install-"));
  const store = new ConnectionsStore(path.join(root, "connections.json"));
  const service = new ConnectorsService({
    connectionsFor: () => store,
    connectorsDirFor: () => path.join(root, "connectors"),
  });
  try {
    await service.searchPlugins("profile", "example");
    readPlugin.mockResolvedValueOnce({
      name: "example",
      description: "",
      mcpServers: {
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { "X-Plugin-Version": "old" },
        },
        local: { transport: "stdio", command: "runtime", env: { OLD: "1" } },
      },
      mcpOAuth: { remote: { clientId: "old-client" } },
    });
    const first = await service.installPlugin(
      "profile",
      "example/plugins",
      "example",
    );
    expect(first.description).toBe("Catalog description");
    expect(first.version).toBe("1.0");
    const remote = store.list().find((entry) => entry.name === "remote");
    if (!remote) throw new Error("Missing remote connection");
    store.update(remote.id, { enabled: false });
    store.setToolPolicy(remote.id, { default: "deny" });

    readPlugin.mockResolvedValueOnce({
      name: "example",
      description: "Updated plugin",
      version: "2.0",
      mcpServers: {
        remote: { transport: "http", url: "https://example.com/mcp" },
        local: { transport: "stdio", command: "runtime" },
      },
      mcpOAuth: {},
    });
    const refreshed = await service.installPlugin(
      "profile",
      "example/plugins",
      "example",
    );
    expect(refreshed.connectionIds).toEqual(first.connectionIds);
    expect(store.get(remote.id)).toMatchObject({
      enabled: false,
      toolPolicy: { default: "deny" },
    });
    expect(store.get(remote.id)?.headers).toBeUndefined();
    expect(store.get(remote.id)?.oauthClient).toBeUndefined();
    expect(
      store.list().find((entry) => entry.name === "local")?.env,
    ).toBeUndefined();

    const before = store.list();
    readPlugin.mockRejectedValueOnce(new Error("Invalid plugin manifest"));
    await expect(
      service.installPlugin("profile", "example/plugins", "example"),
    ).rejects.toThrow("Invalid plugin manifest");
    expect(store.list()).toEqual(before);
    expect(service.listInstalled("profile")).toEqual([refreshed]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
