import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({
  available: true,
  serial: 0,
  failEncrypt: false,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => {
      if (encryption.failEncrypt)
        throw new Error("OS provider failure with private detail");
      return Buffer.from(`sealed:${++encryption.serial}:${value}`);
    },
    decryptString: (value: Buffer) => {
      const text = value.toString();
      const match = /^sealed:\d+:(.*)$/s.exec(text);
      if (!match?.[1]) throw new Error("Invalid ciphertext");
      return match[1];
    },
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
  encryption.available = true;
  encryption.failEncrypt = false;
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

  it.each([
    "headersEncrypted",
    "envEncrypted",
    "oauthEncrypted",
    "oauthClientEncrypted",
  ] as const)(
    "blocks the whole connection when %s is corrupt, preserving healthy connections and recovery",
    (field) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "connection-blocked-"),
      );
      directories.push(directory);
      const file = path.join(directory, "connections.json");
      const original = new ConnectionsStore(file);
      const blocked = original.create({
        name: "Blocked",
        transport: "stdio",
        command: "test-mcp",
        headers: { Authorization: "header-secret" },
        env: { ACCESS_KEY: "env-secret" },
        oauthClient: { clientId: "client", clientSecret: "client-secret" },
      });
      original.setOAuth(blocked.id, {
        tokens: { access_token: "oauth-secret", token_type: "Bearer" },
      });
      const healthy = original.create({
        name: "Healthy",
        transport: "http",
        url: "https://healthy.test/mcp",
      });
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw.connections[0][field] =
        Buffer.from("invalid ciphertext").toString("base64");
      const before = JSON.stringify(raw);
      fs.writeFileSync(file, before);
      const store = new ConnectionsStore(file);
      const read = store.get(blocked.id);
      if (!read) throw new Error("Blocked connection missing");
      expect(read.credentialError).toContain("keychain");
      for (const key of ["headers", "env", "oauth", "oauthClient"])
        expect(read).not.toHaveProperty(key);
      expect(toAgentMcpServer(read)).toBeUndefined();
      expect(toPublicConnection(read).authorizationError).toContain(
        "Unlock your operating system's keychain",
      );
      expect(JSON.stringify(toPublicConnection(read))).not.toContain("secret");
      expect(store.list().map((entry) => entry.id)).toEqual([
        blocked.id,
        healthy.id,
      ]);
      expect(
        toAgentMcpServer(store.get(healthy.id) ?? connection),
      ).toBeDefined();
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(store.update(blocked.id, { name: "Recoverable" })?.name).toBe(
        "Recoverable",
      );
      if (field === "headersEncrypted")
        store.update(blocked.id, { headers: null });
      else if (field === "envEncrypted")
        store.update(blocked.id, { env: null });
      else if (field === "oauthClientEncrypted")
        store.update(blocked.id, { oauthClient: null });
      else store.setOAuth(blocked.id, undefined);
      expect(store.get(blocked.id)).not.toHaveProperty("credentialError");
    },
  );

  it("keeps locked connections visible while refusing anonymous or inherited credential fallback", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "connection-locked-"),
    );
    directories.push(directory);
    const file = path.join(directory, "connections.json");
    const store = new ConnectionsStore(file);
    const saved = store.create({
      name: "CLI",
      transport: "stdio",
      command: "test-cli",
      env: { ACCESS_KEY: "saved-secret" },
    });
    const before = fs.readFileSync(file, "utf8");
    encryption.available = false;
    const blocked = store.get(saved.id);
    if (!blocked) throw new Error("Connection missing");
    expect(toAgentMcpServer(blocked)).toBeUndefined();
    expect(toPublicConnection(blocked).authorizationError).toContain(
      "secure credential store",
    );
    expect(() =>
      store.update(saved.id, { env: { ACCESS_KEY: "replacement" } }),
    ).toThrow("Unlock your operating system's keychain");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(store.update(saved.id, { env: null })).not.toHaveProperty(
      "credentialError",
    );
  });

  it("preserves account identity for equivalent secret patches with randomized ciphertext", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "connection-epoch-"),
    );
    directories.push(directory);
    const file = path.join(directory, "connections.json");
    const store = new ConnectionsStore(file);
    const saved = store.create({
      name: "Company",
      transport: "http",
      url: "https://company.test/mcp",
      headers: { B: "second", A: "first" },
      env: { TOKEN: "key" },
      oauthClient: { clientId: "client", clientSecret: "secret" },
    });
    const before = fs.readFileSync(file, "utf8");
    const epoch = store.securityRevision(saved.id);
    store.update(saved.id, {
      headers: { A: "first", B: "second" },
      env: { TOKEN: "key" },
      oauthClient: { clientSecret: "secret", clientId: "client" },
    });
    expect(store.securityRevision(saved.id)).toBe(epoch);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    store.update(saved.id, { env: { TOKEN: "new-key" } });
    expect(store.securityRevision(saved.id)).toBe(epoch + 1);
  });

  it("wraps encryption failures with safe recovery guidance and preserves the saved record", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "connection-write-"),
    );
    directories.push(directory);
    const file = path.join(directory, "connections.json");
    const store = new ConnectionsStore(file);
    const saved = store.create({
      name: "Company",
      transport: "http",
      url: "https://company.test/mcp",
    });
    const before = fs.readFileSync(file, "utf8");
    encryption.failEncrypt = true;
    expect(() =>
      store.update(saved.id, { headers: { Authorization: "new-secret" } }),
    ).toThrow("Work could not unlock the saved credential");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
