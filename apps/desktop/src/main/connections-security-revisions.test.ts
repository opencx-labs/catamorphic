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

import { ConnectionsStore } from "./connections-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "connection-security-revision-"),
  );
  roots.push(root);
  const store = new ConnectionsStore(path.join(root, "connections.json"));
  const connection = store.create({
    name: "probe",
    transport: "http",
    url: "https://server-a.test/mcp",
    headers: { Authorization: "Bearer account-a" },
  });
  return { store, connection };
}
const tokens = (account: string) => ({
  access_token: account,
  token_type: "Bearer",
  refresh_token: `refresh-${account}`,
});

describe("connection account/config security revisions", () => {
  it("advances on endpoint and credential replacement, including A to B to A", () => {
    const { store, connection } = fixture();
    const initial = store.securityRevision(connection.id);
    store.update(connection.id, { url: "https://server-b.test/mcp" });
    expect(store.securityRevision(connection.id)).toBeGreaterThan(initial);
    store.update(connection.id, { url: connection.url });
    const restored = store.securityRevision(connection.id);
    expect(restored).toBeGreaterThan(initial + 1);
    store.update(connection.id, {
      headers: { Authorization: "Bearer account-b" },
    });
    expect(store.securityRevision(connection.id)).toBeGreaterThan(restored);
  });

  it("keeps equivalent configuration and permission/metadata edits at the same revision", () => {
    const { store, connection } = fixture();
    const initial = store.securityRevision(connection.id);
    store.update(connection.id, {
      url: connection.url,
      headers: connection.headers,
    });
    store.update(connection.id, {
      name: "Renamed",
      ceiling: { source: "Company", policy: { default: "allow" } },
    });
    store.setToolPermission(connection.id, "read", "allow");
    store.setTools(connection.id, [
      { name: "read", description: "Current read tool" },
    ]);
    expect(store.securityRevision(connection.id)).toBe(initial);
  });

  it("preserves the account epoch on routine OAuth renewal and advances on explicit reauthorization", () => {
    const { store, connection } = fixture();
    store.setOAuth(connection.id, { tokens: tokens("account-a") });
    const epoch = store.securityRevision(connection.id);
    store.setOAuth(
      connection.id,
      { tokens: tokens("renewed-account-a") },
      { refresh: true, securityRevision: epoch },
    );
    expect(store.securityRevision(connection.id)).toBe(epoch);
    expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
      "renewed-account-a",
    );
    store.setOAuth(connection.id, { tokens: tokens("account-b") });
    expect(store.securityRevision(connection.id)).toBeGreaterThan(epoch);
    const second = store.securityRevision(connection.id);
    store.setOAuth(connection.id, { tokens: tokens("account-a") });
    expect(store.securityRevision(connection.id)).toBeGreaterThan(second);
  });

  it("refuses stale token renewal after an explicit account change", () => {
    const { store, connection } = fixture();
    store.setOAuth(connection.id, { tokens: tokens("account-a") });
    const oldEpoch = store.securityRevision(connection.id);
    store.setOAuth(connection.id, { tokens: tokens("account-b") });
    expect(() =>
      store.setOAuth(
        connection.id,
        { tokens: tokens("stale-a") },
        { refresh: true, securityRevision: oldEpoch },
      ),
    ).toThrow("authorization changed");
    expect(store.get(connection.id)?.oauth?.tokens?.access_token).toBe(
      "account-b",
    );
  });
});
