import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpOAuthStore } from "@catamorphic/mcp";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  probe: vi.fn(),
  authorize: vi.fn(),
  refresh: vi.fn(),
}));
const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("@catamorphic/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@catamorphic/mcp")>()),
  probeMcpServer: transport.probe,
  authorizeMcpServer: transport.authorize,
  refreshMcpTokens: transport.refresh,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith("sealed:")) throw new Error("Invalid ciphertext");
      return text.slice(7);
    },
  },
}));

import { ConnectionsStore } from "./connections-store.js";
import { ConnectorsService } from "./connectors.js";
import { CredentialStorageError } from "./credential-encryption.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  encryption.available = true;
});

function authorizationFixture(corruptFields: string[] = []) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "connector-authorization-"),
  );
  roots.push(root);
  const file = path.join(root, "connections.json");
  const original = new ConnectionsStore(file);
  const connection = original.create({
    name: "Company",
    transport: "http",
    url: "https://account-a.test/mcp",
    headers: { "X-Company-Key": "header-secret" },
    env: { COMPANY_ENV: "env-secret" },
    oauthClient: { clientId: "client", clientSecret: "client-secret" },
  });
  original.setOAuth(connection.id, {
    tokens: { access_token: "account-a", token_type: "Bearer" },
  });
  original.setToolPolicy(connection.id, { default: "ask" });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const field of corruptFields)
    raw.connections[0][field] =
      Buffer.from("invalid ciphertext").toString("base64");
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = new ConnectionsStore(file);
  const service = new ConnectorsService({
    connectionsFor: () => store,
    connectorsDirFor: () => path.join(root, "connectors"),
  });
  return { store, service, connection, file };
}

it("recovers OAuth-only corruption through Authorize while preserving all unrelated connection settings", async () => {
  const { store, service, connection, file } = authorizationFixture([
    "oauthEncrypted",
  ]);
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  await expect(
    service.probeConnection("profile", connection.id),
  ).resolves.toMatchObject({
    ok: false,
    needsAuth: true,
    error: expect.stringContaining("keychain"),
  });
  expect(transport.probe).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(before);
  transport.authorize.mockImplementation(
    async (
      config: unknown,
      { store: oauth, client }: { store: McpOAuthStore; client?: unknown },
    ) => {
      expect(config).toMatchObject({
        url: "https://account-a.test/mcp",
        headers: { "X-Company-Key": "header-secret" },
      });
      expect(client).toEqual({
        clientId: "client",
        clientSecret: "client-secret",
      });
      expect(oauth.load()).toEqual({});
      oauth.save({ clientInformation: { client_id: "client" } });
      oauth.save({
        ...oauth.load(),
        tokens: { access_token: "reconnected", token_type: "Bearer" },
      });
      return { toolCount: 3 };
    },
  );
  await expect(
    service.authorizeConnection("profile", connection.id, { openUrl: vi.fn() }),
  ).resolves.toEqual({ toolCount: 3 });
  expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
    "reconnected",
  );
  expect(store.get(connection.id)).not.toHaveProperty("credentialError");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  after.connections[0].oauthEncrypted = before.connections[0].oauthEncrypted;
  expect(after).toEqual(before);
});

it.each(["headersEncrypted", "envEncrypted", "oauthClientEncrypted"])(
  "refuses OAuth recovery if %s is also unreadable",
  async (field) => {
    const { service, connection, file } = authorizationFixture([
      "oauthEncrypted",
      field,
    ]);
    const before = fs.readFileSync(file, "utf8");
    const probe = await service.probeConnection("profile", connection.id);
    expect(probe.ok).toBe(false);
    expect(probe.needsAuth).not.toBe(true);
    await expect(
      service.authorizeConnection("profile", connection.id, {
        openUrl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(CredentialStorageError);
    expect(transport.authorize).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  },
);

it("refuses to reset unreadable OAuth when OS secure storage is unavailable", async () => {
  const { service, connection, file } = authorizationFixture([
    "oauthEncrypted",
  ]);
  const before = fs.readFileSync(file, "utf8");
  encryption.available = false;
  await expect(
    service.authorizeConnection("profile", connection.id, { openUrl: vi.fn() }),
  ).rejects.toThrow("secure credential store");
  expect(transport.authorize).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it.each(["endpoint", "account"])(
  "fences interactive OAuth load and save after an external %s change",
  async (change) => {
    const { store, service, connection, file } = authorizationFixture();
    transport.authorize.mockImplementation(
      async (_config: unknown, { store: oauth }: { store: McpOAuthStore }) => {
        oauth.save({ ...oauth.load(), codeVerifier: "own-flow" });
        if (change === "endpoint")
          store.update(connection.id, { url: "https://account-b.test/mcp" });
        else
          store.setOAuth(connection.id, {
            tokens: { access_token: "account-b", token_type: "Bearer" },
          });
        const current = fs.readFileSync(file, "utf8");
        expect(() => oauth.load()).toThrow("changed during authorization");
        expect(() =>
          oauth.save({
            tokens: { access_token: "stale-account-a", token_type: "Bearer" },
          }),
        ).toThrow("changed during authorization");
        expect(fs.readFileSync(file, "utf8")).toBe(current);
        return { toolCount: 1 };
      },
    );
    await expect(
      service.authorizeConnection("profile", connection.id, {
        openUrl: vi.fn(),
      }),
    ).rejects.toThrow("changed during authorization");
    expect(store.get(connection.id)?.oauth?.tokens?.access_token).not.toBe(
      "stale-account-a",
    );
    if (change === "account")
      expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
        "account-b",
      );
  },
);

it("advances the interactive fence for its own state writes without absorbing listener-triggered changes", async () => {
  const { store, service, connection } = authorizationFixture();
  let changed = false;
  const stop = store.onChanged(() => {
    if (changed) return;
    changed = true;
    store.update(connection.id, { url: "https://account-b.test/mcp" });
  });
  transport.authorize.mockImplementation(
    async (_config: unknown, { store: oauth }: { store: McpOAuthStore }) => {
      oauth.save({ ...oauth.load(), codeVerifier: "own-flow" });
      return { toolCount: 1 };
    },
  );
  try {
    await expect(
      service.authorizeConnection("profile", connection.id, {
        openUrl: vi.fn(),
      }),
    ).rejects.toThrow("changed during authorization");
  } finally {
    stop();
  }
  expect(store.get(connection.id)?.url).toBe("https://account-b.test/mcp");
});

it("accepts successive state writes owned by the same interactive flow", async () => {
  const { store, service, connection } = authorizationFixture();
  const epoch = store.securityRevision(connection.id);
  transport.authorize.mockImplementation(
    async (_config: unknown, { store: oauth }: { store: McpOAuthStore }) => {
      oauth.save({
        ...oauth.load(),
        clientInformation: { client_id: "client" },
      });
      oauth.save({ ...oauth.load(), codeVerifier: "own-flow" });
      oauth.save({
        ...oauth.load(),
        tokens: { access_token: "new-account", token_type: "Bearer" },
      });
      return { toolCount: 2 };
    },
  );
  await expect(
    service.authorizeConnection("profile", connection.id, { openUrl: vi.fn() }),
  ).resolves.toEqual({ toolCount: 2 });
  expect(store.securityRevision(connection.id)).toBe(epoch + 3);
  expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
    "new-account",
  );
});

it("blocks probe and interactive authorization before transport when encrypted credentials are corrupt, while refreshing healthy connections", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-blocked-"));
  roots.push(root);
  const file = path.join(root, "connections.json");
  const original = new ConnectionsStore(file);
  const blocked = original.create({
    name: "Blocked",
    transport: "http",
    url: "https://blocked.test/mcp",
    headers: { Authorization: "private-header" },
    oauthClient: { clientId: "client", clientSecret: "private-client" },
  });
  original.setOAuth(blocked.id, {
    tokens: { access_token: "private-token", token_type: "Bearer" },
  });
  const healthy = original.create({
    name: "Healthy",
    transport: "http",
    url: "https://healthy.test/mcp",
  });
  original.setOAuth(healthy.id, {
    tokens: { access_token: "healthy-token", token_type: "Bearer" },
  });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.connections[0].headersEncrypted =
    Buffer.from("invalid ciphertext").toString("base64");
  fs.writeFileSync(file, JSON.stringify(raw));
  const before = fs.readFileSync(file, "utf8");
  const store = new ConnectionsStore(file);
  const service = new ConnectorsService({
    connectionsFor: () => store,
    connectorsDirFor: () => path.join(root, "connectors"),
  });
  await expect(
    service.probeConnection("profile", blocked.id),
  ).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("keychain"),
  });
  expect(transport.probe).not.toHaveBeenCalled();
  const openUrl = vi.fn();
  await expect(
    service.authorizeConnection("profile", blocked.id, { openUrl }),
  ).rejects.toBeInstanceOf(CredentialStorageError);
  expect(openUrl).not.toHaveBeenCalled();
  expect(transport.authorize).not.toHaveBeenCalled();
  await service.refreshTokens("profile");
  expect(transport.refresh).toHaveBeenCalledOnce();
  expect(transport.refresh.mock.calls[0]?.[0]).toMatchObject({
    url: "https://healthy.test/mcp",
  });
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});
