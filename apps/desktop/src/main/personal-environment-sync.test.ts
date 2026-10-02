import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_ENVIRONMENT_STATUS_PATH,
  sha256,
} from "./personal-environment-config.js";
import {
  type PersonalEnvironmentSnapshot,
  PersonalEnvironmentSync,
  shouldUpload,
  snapshotFingerprint,
  uploadFromSnapshot,
} from "./personal-environment-sync.js";
import {
  RemoteAuthError,
  type RemotePersonalEnvironment,
  type RemotePersonalEnvironmentUpload,
} from "./remote-sync.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const file = (filePath: string, content: string) => ({
  path: filePath,
  content: Buffer.from(content),
  bytes: content.length,
  problem: null,
  fingerprint: sha256(content),
});

const snapshot = (
  files: ReturnType<typeof file>[] = [],
): PersonalEnvironmentSnapshot => ({
  files,
  fingerprint: snapshotFingerprint({ files }),
});

const remote = (
  overrides: Partial<RemotePersonalEnvironment> = {},
): RemotePersonalEnvironment => ({
  allowed: true,
  files: [],
  ...overrides,
});

describe("snapshots", () => {
  it("fingerprints file contents, not unreadable files", () => {
    const base = snapshot([file(".env", "A=1")]);
    expect(snapshot([file(".env", "A=1")]).fingerprint).toBe(base.fingerprint);
    expect(snapshot([file(".env", "A=2")]).fingerprint).not.toBe(
      base.fingerprint,
    );
    expect(
      snapshotFingerprint({
        files: [
          file(".env", "A=1"),
          {
            path: "gone",
            content: null,
            bytes: null,
            problem: "Not found in the project folder",
            fingerprint: null,
          },
        ],
      }),
    ).toBe(base.fingerprint);
  });

  it("uploads only files, as base64", () => {
    const upload = uploadFromSnapshot(
      snapshot([file("apps/api/.env.local", "B=2")]),
    );
    expect(upload).toEqual({
      files: [
        {
          path: "apps/api/.env.local",
          content: Buffer.from("B=2").toString("base64"),
        },
      ],
    });
  });
});

describe("shouldUpload", () => {
  const local = snapshot([file(".env", "A=1")]);
  const matching = remote({
    files: [{ path: ".env", fingerprint: "x", bytes: 3, updatedAt: at(-1) }],
  });

  it("sends what changed since the last send", () => {
    expect(
      shouldUpload({
        snapshot: local,
        lastSentFingerprint: null,
        remote: matching,
      }),
    ).toBe(true);
    expect(
      shouldUpload({
        snapshot: local,
        lastSentFingerprint: local.fingerprint,
        remote: matching,
      }),
    ).toBe(false);
  });

  it("never sends when no Environment allows it", () => {
    expect(
      shouldUpload({
        snapshot: local,
        lastSentFingerprint: null,
        remote: { ...matching, allowed: false },
      }),
    ).toBe(false);
  });

  it("sends again when the server's copy drifted", () => {
    const sent = local.fingerprint;
    expect(
      shouldUpload({
        snapshot: local,
        lastSentFingerprint: sent,
        remote: { ...matching, files: [] },
      }),
    ).toBe(true);
  });
});

describe("PersonalEnvironmentSync", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(options: {
    remote?: RemotePersonalEnvironment | null;
    config?: unknown;
    files?: Record<string, string>;
    signedOut?: boolean;
  }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-sync-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    if (options.config !== undefined) {
      const target = path.join(root, PERSONAL_ENVIRONMENT_PATH);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        typeof options.config === "string"
          ? options.config
          : JSON.stringify(options.config),
      );
    }
    for (const [name, content] of Object.entries(options.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    let server: RemotePersonalEnvironment | null =
      options.remote === undefined ? remote() : options.remote;
    const puts: RemotePersonalEnvironmentUpload[] = [];
    const client = {
      personalEnvironment: vi.fn(async () => server),
      putPersonalEnvironment: vi.fn(
        async (body: RemotePersonalEnvironmentUpload) => {
          puts.push(body);
          if (server)
            server = {
              ...server,
              files: body.files.map((entry) => ({
                path: entry.path,
                fingerprint: "s",
                bytes: Buffer.from(entry.content, "base64").length,
                updatedAt: at(0),
              })),
            };
        },
      ),
      deletePersonalEnvironment: vi.fn(async () => {
        if (server) server = { ...server, files: [] };
      }),
    };
    const sync = new PersonalEnvironmentSync({
      links: () => [
        {
          profileId: "profile",
          localProjectId: "project",
          serverUrl: "https://work.example/api",
          client: options.signedOut ? null : client,
        },
      ],
      projectRoot: async () => root,
      now: () => NOW,
      watchFiles: false,
    });
    const target = { profileId: "profile", projectId: "project" };
    return {
      root,
      sync,
      target,
      client,
      puts,
    };
  }

  it("sends an empty set by default and never a sign-in", async () => {
    const env = setup({});
    const view = await env.sync.syncNow(env.target);
    expect(env.puts).toEqual([{ files: [] }]);
    expect(view.server).toBe("allowed");
    expect(view.lastSyncAt).toBe(at(0));
    expect(view).not.toHaveProperty("logins");
    // Nothing changed: the next check does not send again.
    await env.sync.syncNow(env.target);
    expect(env.puts).toHaveLength(1);
  });

  it("sends listed files and re-sends when one changes", async () => {
    const env = setup({
      config: { files: ["apps/api/.env.local", "missing"] },
      files: { "apps/api/.env.local": "B=2" },
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.puts[0]).toEqual({
      files: [
        {
          path: "apps/api/.env.local",
          content: Buffer.from("B=2").toString("base64"),
        },
      ],
    });
    expect(view.files).toEqual([
      {
        path: "apps/api/.env.local",
        bytes: 3,
        problem: null,
        server: { bytes: 3, updatedAt: at(0) },
      },
      {
        path: "missing",
        bytes: null,
        problem: "Not found in the project folder",
        server: null,
      },
    ]);
    fs.writeFileSync(path.join(env.root, "apps/api/.env.local"), "B=3");
    await env.sync.syncNow(env.target);
    expect(env.puts).toHaveLength(2);
    const status = JSON.parse(
      fs.readFileSync(
        path.join(env.root, PERSONAL_ENVIRONMENT_STATUS_PATH),
        "utf8",
      ),
    );
    expect(status).toMatchObject({
      server: "allowed",
      files: [
        { path: "apps/api/.env.local", onServer: true, problem: null },
        { path: "missing", onServer: false },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("B=3");
    expect(status).not.toHaveProperty("logins");
  });

  it("sends nothing where no Environment allows it and takes back an old copy", async () => {
    const env = setup({
      remote: remote({
        allowed: false,
        files: [
          { path: ".env", fingerprint: "x", bytes: 1, updatedAt: at(-1) },
        ],
      }),
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.puts).toEqual([]);
    expect(env.client.deletePersonalEnvironment).toHaveBeenCalledTimes(1);
    expect(view.server).toBe("not-allowed");
    await env.sync.syncNow(env.target);
    expect(env.client.deletePersonalEnvironment).toHaveBeenCalledTimes(1);
  });

  it("reports servers without the routes, sign-in and unreachable servers", async () => {
    const unsupported = setup({ remote: null });
    expect((await unsupported.sync.syncNow(unsupported.target)).server).toBe(
      "unsupported",
    );
    expect(unsupported.client.putPersonalEnvironment).not.toHaveBeenCalled();

    const signedOut = setup({ signedOut: true });
    expect((await signedOut.sync.syncNow(signedOut.target)).server).toBe(
      "sign-in",
    );

    const expired = setup({});
    expired.client.personalEnvironment.mockRejectedValueOnce(
      new RemoteAuthError("Reading your remote environment"),
    );
    expect((await expired.sync.syncNow(expired.target)).server).toBe("sign-in");

    const offline = setup({});
    offline.client.personalEnvironment.mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );
    const view = await offline.sync.syncNow(offline.target);
    expect(view.server).toBe("unreachable");
    expect(view.error).toBe("The project's server could not be reached");
  });

  it("tells agents when the server needs signing in again", async () => {
    const signedOut = setup({ signedOut: true });
    await signedOut.sync.syncNow(signedOut.target);
    const status = JSON.parse(
      fs.readFileSync(
        path.join(signedOut.root, PERSONAL_ENVIRONMENT_STATUS_PATH),
        "utf8",
      ),
    );
    expect(status.server).toBe("sign-in");
  });

  it("does not send while the config file is broken", async () => {
    const env = setup({
      config: '{"files": ["../outside"]}',
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.puts).toEqual([]);
    expect(view.configError).toContain("outside the project folder");
    expect(view.configExists).toBe(true);
  });

  it("notifies subscribers and renders a first view while checking", async () => {
    const env = setup({});
    const changes: string[] = [];
    env.sync.subscribe((change) => changes.push(change.projectId));
    const first = env.sync.view(env.target);
    expect(first.server).toBe("unknown");
    expect(first.syncing).toBe(false);
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(2));
    expect(env.sync.view(env.target).server).toBe("allowed");
  });
});
