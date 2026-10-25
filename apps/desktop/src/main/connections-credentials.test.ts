import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ""),
  },
}));

import {
  ConnectionsStore,
  type McpConnection,
  toAgentMcpServer,
  toPublicConnection,
} from "./connections-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const connection: McpConnection = {
  id: "github",
  name: "GitHub",
  enabled: true,
  source: { kind: "manual" },
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for plugin credential expansion
  headers: { Authorization: "Bearer ${CATAMORPHIC_TEST_GITHUB_TOKEN}" },
};
describe("connection credentials", () => {
  it("encrypts confidential OAuth clients and never returns them to the renderer", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "connection-secrets-"),
    );
    directories.push(directory);
    const file = path.join(directory, "connections.json");
    const store = new ConnectionsStore(file);
    const created = store.create({
      name: "Company MCP",
      transport: "http",
      url: "https://mcp.example.test",
      oauthClient: {
        clientId: "company",
        clientSecret: "confidential-client-secret",
      },
    });
    expect(fs.readFileSync(file, "utf8")).not.toContain(
      "confidential-client-secret",
    );
    expect(store.get(created.id)?.oauthClient?.clientSecret).toBe(
      "confidential-client-secret",
    );
    const publicConnection = toPublicConnection({
      ...created,
      ...{ unexpectedSecret: "hidden-secret" },
    });
    expect(publicConnection).not.toHaveProperty("oauthClient");
    expect(publicConnection).not.toHaveProperty("unexpectedSecret");
    expect(JSON.stringify(publicConnection)).not.toContain(
      "confidential-client-secret",
    );
    store.update(created.id, {
      oauthClient: {
        clientId: "company",
        clientSecret: "rotated-client-secret",
      },
    });
    expect(fs.readFileSync(file, "utf8")).not.toContain(
      "rotated-client-secret",
    );
    expect(store.get(created.id)?.oauthClient?.clientSecret).toBe(
      "rotated-client-secret",
    );
  });

  it("refuses unsupported or corrupt settings without replacing the file", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "connection-settings-"),
    );
    directories.push(directory);
    const file = path.join(directory, "connections.json");
    for (const data of [
      "{broken",
      JSON.stringify({
        connections: [{ id: "a", unexpectedSecret: "hidden-secret" }],
      }),
    ]) {
      fs.writeFileSync(file, data);
      expect(() => new ConnectionsStore(file)).toThrow(
        "Connection settings could not be opened",
      );
      expect(fs.readFileSync(file, "utf8")).toBe(data);
    }
  });
  it("expands stored secrets only for the harness, never in public metadata", () => {
    const configured = {
      ...connection,
      env: { CATAMORPHIC_TEST_GITHUB_TOKEN: "test-secret" },
    };
    expect(toAgentMcpServer(configured)).toMatchObject({
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(JSON.stringify(toPublicConnection(configured))).not.toContain(
      "test-secret",
    );
  });
  it("reports missing authorization without starting a server with a literal placeholder", () => {
    expect(toAgentMcpServer(connection)).toBeUndefined();
    expect(toPublicConnection(connection).authorizationError).toContain(
      "CATAMORPHIC_TEST_GITHUB_TOKEN",
    );
  });
});
