import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import { ConnectionsStore } from "./connections-store.js";
import { ConnectorsService } from "./connectors.js";

it("imports native Codex in place, preserves assignments and policy on refresh, and leaves its installation on removal", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-connector-"),
  );
  const home = path.join(root, "codex");
  const cache = path.join(
    home,
    "plugins/cache/openai-bundled/unified-computer-use",
  );
  const writeVersion = async (version: string) => {
    const dir = path.join(cache, version);
    await fs.mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: "unified-computer-use", version }),
    );
    await fs.writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          cua_repl: {
            command: process.execPath,
            args: ["runtime.mjs"],
            env: { CUA_REPL_ENABLED_SURFACES: "browser,computer" },
          },
        },
      }),
    );
    return dir;
  };
  const store = new ConnectionsStore(path.join(root, "connections.json"));
  const service = new ConnectorsService({
    connectionsFor: () => store,
    connectorsDirFor: () => path.join(root, "connectors"),
  });
  try {
    await expect(
      service.connectCodexComputerUse("profile", home),
    ).rejects.toThrow("Install Computer Use");
    const old = await writeVersion("1.9");
    await fs.writeFile(path.join(cache, "zzz-metadata.json"), "{}");
    const first = await service.connectCodexComputerUse("profile", home);
    const id = first.connectionIds[0];
    if (!id) throw new Error("Missing connection");
    expect(store.get(id)?.env?.CUA_REPL_ENABLED_SURFACES).toBe("computer");
    expect(store.get(id)?.toolPolicy).toEqual({
      default: "deny",
      tools: { js: "allow", js_reset: "allow" },
    });
    store.setToolPolicy(id, { default: "deny" });
    const latest = await writeVersion("1.10");
    await fs.rm(old, { recursive: true });
    await service.refreshTokens("profile");
    expect(service.listInstalled("profile")[0]?.path).toBe(latest);
    expect(service.listInstalled("profile")[0]?.connectionIds).toEqual([id]);
    expect(store.get(id)?.toolPolicy).toEqual({ default: "deny" });
    await service.removeConnector("profile", "codex-computer-use");
    expect(store.get(id)).toBeUndefined();
    await expect(fs.access(latest)).resolves.toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
