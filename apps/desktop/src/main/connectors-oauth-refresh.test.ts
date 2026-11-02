import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpOAuthStore } from "@catamorphic/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@catamorphic/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@catamorphic/mcp")>()),
  refreshMcpTokens: mock.refresh,
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ""),
  },
}));

import { ConnectionsStore } from "./connections-store.js";
import { ConnectorsService } from "./connectors.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "connector-token-renewal-"),
  );
  roots.push(root);
  const store = new ConnectionsStore(path.join(root, "connections.json"));
  const connection = store.create({
    name: "probe",
    transport: "http",
    url: "https://server.test/mcp",
  });
  store.setOAuth(connection.id, {
    tokens: {
      access_token: "account-a",
      refresh_token: "refresh-a",
      token_type: "Bearer",
    },
  });
  const service = new ConnectorsService({
    connectionsFor: () => store,
    connectorsDirFor: () => path.join(root, "connectors"),
  });
  return { store, connection, service };
}

describe("the connector OAuth renewal seam", () => {
  it("marks only routine renewal writes as preserving the account epoch", async () => {
    const { store, connection, service } = fixture();
    const epoch = store.securityRevision(connection.id);
    mock.refresh.mockImplementation(
      async (_config: unknown, oauth: McpOAuthStore) => {
        oauth.save({
          ...oauth.load(),
          tokens: {
            access_token: "renewed-a",
            refresh_token: "renewed-refresh-a",
            token_type: "Bearer",
          },
        });
        return true;
      },
    );
    await service.refreshTokens("profile");
    expect(mock.refresh).toHaveBeenCalledOnce();
    expect(store.securityRevision(connection.id)).toBe(epoch);
    expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
      "renewed-a",
    );
  });

  it("cannot let a pending old-account renewal overwrite explicit reauthorization", async () => {
    const { store, connection, service } = fixture();
    mock.refresh
      .mockReset()
      .mockImplementation(async (_config: unknown, oauth: McpOAuthStore) => {
        store.setOAuth(connection.id, {
          tokens: { access_token: "account-b", token_type: "Bearer" },
        });
        oauth.save({
          tokens: { access_token: "stale-a", token_type: "Bearer" },
        });
        return true;
      });
    await service.refreshTokens("profile");
    expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
      "account-b",
    );
  });
});
