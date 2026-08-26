import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
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
    raw.credentials["connection-1"].credentialsPlaintext = "not-json";
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
