import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import {
  REMOTE_PROJECT_LOCATOR_PATH,
  RemoteProjectsStore,
  readRemoteProjectLocator,
  writeRemoteProjectLocator,
} from "./remote-projects-store.js";

const dirs: string[] = [];

afterEach(() => {
  encryption.available = true;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe("RemoteProjectsStore", () => {
  it("preserves the remote locator when credentials cannot be read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-store-"));
    dirs.push(dir);
    const file = path.join(dir, "remotes.json");
    const store = new RemoteProjectsStore(file);
    store.set("local1", {
      connectionId: "connection-1",
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "remote1",
      remoteProjectName: "Acme Brain",
      lastSyncAt: null,
      credentials: {
        clientId: "client-1",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: "2026-08-27T00:00:00.000Z",
        tokenEndpoint: "https://brain.acme.dev/api/auth/mcp/token",
        scope: "openid",
      },
    });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.credentials["connection-1"].credentialsEncrypted =
      Buffer.from("not-json").toString("base64");
    fs.writeFileSync(file, JSON.stringify(raw));

    const inspected = new RemoteProjectsStore(file).inspect("local1");

    expect(inspected?.link).toMatchObject({
      connectionId: "connection-1",
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "remote1",
      remoteProjectName: "Acme Brain",
    });
    expect(inspected?.credentials).toBeNull();
  });

  it("keeps credentials session-only when OS encryption is unavailable", () => {
    encryption.available = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-session-"));
    dirs.push(dir);
    const file = path.join(dir, "remotes.json");
    const store = new RemoteProjectsStore(file);
    store.set("local1", remoteLink());

    expect(store.get("local1")?.credentials.accessToken).toBe("access-1");
    expect(fs.readFileSync(file, "utf8")).not.toContain("access-1");
    expect(new RemoteProjectsStore(file).get("local1")).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("single-flights refreshes for every consumer of one connection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-refresh-"));
    dirs.push(dir);
    const store = new RemoteProjectsStore(path.join(dir, "remotes.json"));
    store.set("local1", remoteLink());
    const refresh = vi.fn(async () => ({
      ...remoteLink().credentials,
      accessToken: "access-2",
      refreshToken: "refresh-2",
    }));

    const [first, second] = await Promise.all([
      store.accessToken("local1", { forceRefresh: true, refresh }),
      store.accessToken("local1", { forceRefresh: true, refresh }),
    ]);

    expect([first, second]).toEqual(["access-2", "access-2"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers a project mapping from its non-secret local locator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-locator-"));
    dirs.push(dir);
    const locator = {
      connectionId: "connection-1",
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "remote1",
      remoteProjectName: "Acme Brain",
      lastSyncAt: null,
    };

    writeRemoteProjectLocator(dir, locator);
    const store = new RemoteProjectsStore(path.join(dir, "profile.json"));
    const recovered = readRemoteProjectLocator(dir);
    expect(recovered).not.toBeNull();
    if (!recovered) throw new Error("Locator was not recovered");
    store.setLocator("local1", recovered);

    expect(store.inspect("local1")).toEqual({
      link: locator,
      credentials: null,
    });
    expect(
      fs.readFileSync(path.join(dir, REMOTE_PROJECT_LOCATOR_PATH), "utf8"),
    ).not.toContain("Token");
  });
});

function remoteLink() {
  return {
    connectionId: "connection-1",
    serverUrl: "https://brain.acme.dev/api",
    remoteProjectId: "remote1",
    remoteProjectName: "Acme Brain",
    lastSyncAt: null,
    credentials: {
      clientId: "client-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: "2026-08-27T00:00:00.000Z",
      tokenEndpoint: "https://brain.acme.dev/api/auth/mcp/token",
      scope: "openid",
    },
  };
}
