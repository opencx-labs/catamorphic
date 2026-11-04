import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({ locked: false }));
const remote = vi.hoisted(() => {
  const reads: string[] = [];
  const uploads: Array<{
    projectId: string;
    files: Array<{ path: string; content: string }>;
  }> = [];
  return { reads, uploads };
});
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text: string) => Buffer.from(`sealed:${text}`),
    decryptString: (ciphertext: Buffer) => {
      const text = ciphertext.toString();
      if (
        !text.startsWith("sealed:") ||
        (encryption.locked && text.includes("blocked-token"))
      )
        throw new Error("Saved token cannot be decrypted");
      return text.slice(7);
    },
  },
}));
vi.mock("./remote-oauth.js", () => ({
  refreshRemoteCredentials: async () => {
    throw new Error("Unexpected token refresh");
  },
}));
vi.mock("./remote-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-sync.js")>()),
  httpDocumentsClient: ({
    projectId,
    accessToken,
  }: {
    projectId: string;
    accessToken(): Promise<string>;
  }) => ({
    personalEnvironment: async () => {
      await accessToken();
      remote.reads.push(projectId);
      return { allowed: true, files: [], setup: null };
    },
    putPersonalEnvironment: async (body: {
      files: Array<{ path: string; content: string }>;
    }) => {
      await accessToken();
      remote.uploads.push({ projectId, files: body.files });
    },
    deletePersonalEnvironment: async () => {
      await accessToken();
    },
  }),
}));

import { PERSONAL_ENVIRONMENT_PATH } from "./personal-environment-config.js";
import { desktopPersonalEnvironment } from "./personal-environment-host.js";
import type { PersonalEnvironmentSync } from "./personal-environment-sync.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";

const dirs: string[] = [];
const services: PersonalEnvironmentSync[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  encryption.locked = false;
  remote.reads.length = 0;
  remote.uploads.length = 0;
});

function link(projectId: string, accessToken: string) {
  return {
    connectionId: `connection-${projectId}`,
    serverUrl: "https://work.example/api",
    remoteProjectId: projectId,
    remoteProjectName: projectId,
    lastSyncAt: null,
    credentials: {
      accessToken,
      clientId: "test-client",
      refreshToken: "test-refresh",
      accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
      tokenEndpoint: "https://work.example/api/auth/oauth2/token",
      scope: "openid",
    },
  };
}

it.each(["locked", "corrupt"])(
  "keeps discovery and healthy-profile sync independent of a %s token",
  async (condition) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-host-"));
    dirs.push(dir);
    const roots = new Map<string, string>();
    for (const id of ["blocked", "healthy", "signed-out"]) {
      const root = path.join(dir, id);
      roots.set(id, root);
      fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
      const config = path.join(root, PERSONAL_ENVIRONMENT_PATH);
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify({ files: [".env"] }));
      fs.writeFileSync(path.join(root, ".env"), "TOKEN=listed-file");
    }
    const blockedFile = path.join(dir, "blocked-remotes.json");
    const healthyFile = path.join(dir, "healthy-remotes.json");
    const original = new RemoteProjectsStore(blockedFile);
    original.set("blocked", link("blocked", "blocked-token"));
    const { credentials: _credentials, ...locator } = link(
      "signed-out",
      "unused",
    );
    original.setLocator("signed-out", locator);
    new RemoteProjectsStore(healthyFile).set(
      "healthy",
      link("healthy", "healthy-token"),
    );
    if (condition === "corrupt") {
      const raw = JSON.parse(fs.readFileSync(blockedFile, "utf8"));
      raw.credentials["connection-blocked"].credentialsEncrypted =
        Buffer.from("invalid ciphertext").toString("base64");
      fs.writeFileSync(blockedFile, JSON.stringify(raw));
    } else encryption.locked = true;
    const saved = fs.readFileSync(blockedFile, "utf8");
    const blockedStore = new RemoteProjectsStore(blockedFile);
    const healthyStore = new RemoteProjectsStore(healthyFile);
    const blockedRead = vi.spyOn(blockedStore, "inspect");
    const sync = desktopPersonalEnvironment({
      profiles: {
        list: () => ({
          profiles: ["blocked-profile", "healthy-profile"].map((id) => ({
            id,
            name: id,
            color: "orange",
            projectIds: [],
          })),
          defaultProfileId: "healthy-profile",
        }),
      },
      profileConfig: {
        forProfile: (id) => ({
          remoteProjects:
            id === "blocked-profile" ? blockedStore : healthyStore,
        }),
      },
      projectRoot: async (id) => roots.get(id) ?? null,
    });
    services.push(sync);
    const healthy = await sync.syncNow({
      profileId: "healthy-profile",
      projectId: "healthy",
    });
    expect(healthy.server).toBe("allowed");
    expect(blockedRead).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([
      {
        projectId: "healthy",
        files: [
          {
            path: ".env",
            content: Buffer.from("TOKEN=listed-file").toString("base64"),
          },
        ],
      },
    ]);
    await expect(sync.checkAll()).resolves.toBeUndefined();
    expect(remote.reads.every((id) => id === "healthy")).toBe(true);
    const blocked = await sync.view({
      profileId: "blocked-profile",
      projectId: "blocked",
    });
    expect(blocked.error).toContain("Unlock your operating system's keychain");
    expect(blocked.syncing).toBe(false);
    expect(
      (
        await sync.syncNow({
          profileId: "blocked-profile",
          projectId: "signed-out",
        })
      ).server,
    ).toBe("sign-in");
    expect(fs.readFileSync(blockedFile, "utf8")).toBe(saved);
    if (condition === "locked") {
      encryption.locked = false;
      expect(
        (
          await sync.syncNow({
            profileId: "blocked-profile",
            projectId: "blocked",
          })
        ).server,
      ).toBe("allowed");
    }
  },
);
