import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalHarness } from "../shared/personal-environment.js";
import { type LocalLogin, loginFingerprint } from "./harness-logins.js";
import {
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_ENVIRONMENT_STATUS_PATH,
} from "./personal-environment-config.js";
import {
  loginRefreshDecision,
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

const login = (
  harness: PersonalHarness,
  expiresAt: string | null,
  token = "a",
): LocalLogin => {
  const payload =
    harness === "claude-code"
      ? JSON.stringify({ claudeAiOauth: { accessToken: token } })
      : JSON.stringify({ tokens: { access_token: token } });
  return {
    harness,
    payload,
    expiresAt,
    fingerprint: loginFingerprint(payload),
  };
};

const file = (filePath: string, content: string) => ({
  path: filePath,
  content: Buffer.from(content),
  bytes: content.length,
  problem: null,
  fingerprint: loginFingerprint(content),
});

const snapshot = (
  logins: LocalLogin[],
  files: ReturnType<typeof file>[] = [],
): PersonalEnvironmentSnapshot => ({
  logins,
  files,
  fingerprint: snapshotFingerprint({ logins, files }),
});

const remote = (
  overrides: Partial<RemotePersonalEnvironment> = {},
): RemotePersonalEnvironment => ({
  allowed: true,
  logins: {},
  files: [],
  ...overrides,
});

describe("snapshots", () => {
  it("fingerprints logins and file contents, not unreadable files", () => {
    const base = snapshot([login("codex", at(60))], [file(".env", "A=1")]);
    expect(
      snapshot([login("codex", at(60))], [file(".env", "A=1")]).fingerprint,
    ).toBe(base.fingerprint);
    expect(
      snapshot([login("codex", at(60), "b")], [file(".env", "A=1")])
        .fingerprint,
    ).not.toBe(base.fingerprint);
    expect(
      snapshot([login("codex", at(60))], [file(".env", "A=2")]).fingerprint,
    ).not.toBe(base.fingerprint);
    expect(
      snapshotFingerprint({
        logins: [login("codex", at(60))],
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

  it("uploads logins in the contract's shape and files as base64", () => {
    const upload = uploadFromSnapshot(
      snapshot(
        [login("claude-code", at(30)), login("codex", null)],
        [file("apps/api/.env.local", "B=2")],
      ),
    );
    expect(upload).toEqual({
      logins: {
        "claude-code": {
          credentials: JSON.stringify({ claudeAiOauth: { accessToken: "a" } }),
          expiresAt: at(30),
        },
        codex: { auth: JSON.stringify({ tokens: { access_token: "a" } }) },
      },
      files: [
        {
          path: "apps/api/.env.local",
          content: Buffer.from("B=2").toString("base64"),
        },
      ],
    });
  });
});

describe("loginRefreshDecision", () => {
  const needs = (expiresAt: string) => ({
    fingerprint: "f",
    expiresAt,
    updatedAt: at(-60),
    needsRefresh: true,
  });

  it("does nothing unless the server asks", () => {
    expect(
      loginRefreshDecision({
        harness: "codex",
        local: { expiresAt: at(30) },
        remote: { ...needs(at(30)), needsRefresh: false },
        now: NOW,
      }),
    ).toBe("none");
    expect(
      loginRefreshDecision({
        harness: "codex",
        local: null,
        remote: needs(at(30)),
        now: NOW,
      }),
    ).toBe("none");
  });

  it("sends a local login that is already fresher", () => {
    expect(
      loginRefreshDecision({
        harness: "claude-code",
        local: { expiresAt: at(480) },
        remote: needs(at(30)),
        now: NOW,
      }),
    ).toBe("send");
  });

  it("refreshes Codex at once and Claude Code only inside its window", () => {
    expect(
      loginRefreshDecision({
        harness: "codex",
        local: { expiresAt: at(30) },
        remote: needs(at(30)),
        now: NOW,
      }),
    ).toBe("refresh");
    expect(
      loginRefreshDecision({
        harness: "claude-code",
        local: { expiresAt: at(30) },
        remote: needs(at(30)),
        now: NOW,
      }),
    ).toBe("wait");
    expect(
      loginRefreshDecision({
        harness: "claude-code",
        local: { expiresAt: at(4) },
        remote: needs(at(4)),
        now: NOW,
      }),
    ).toBe("refresh");
    expect(
      loginRefreshDecision({
        harness: "claude-code",
        local: { expiresAt: at(-5) },
        remote: needs(at(-5)),
        now: NOW,
      }),
    ).toBe("refresh");
  });
});

describe("shouldUpload", () => {
  const local = snapshot([login("codex", at(60))], [file(".env", "A=1")]);
  const matching = remote({
    logins: {
      codex: {
        fingerprint: "server-side",
        expiresAt: at(60),
        updatedAt: at(-1),
        needsRefresh: false,
      },
    },
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
    expect(
      shouldUpload({
        snapshot: local,
        lastSentFingerprint: sent,
        remote: { ...matching, logins: {} },
      }),
    ).toBe(true);
    expect(
      shouldUpload({
        snapshot: local,
        lastSentFingerprint: sent,
        remote: {
          ...matching,
          logins: {
            codex: {
              fingerprint: "old",
              expiresAt: at(10),
              updatedAt: at(-100),
              needsRefresh: true,
            },
          },
        },
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
    logins?: Partial<Record<PersonalHarness, LocalLogin>>;
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
    const logins = { ...options.logins };
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
              logins: Object.fromEntries(
                Object.entries(body.logins).map(([harness, entry]) => [
                  harness,
                  {
                    fingerprint: "s",
                    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
                    updatedAt: at(0),
                    needsRefresh: false,
                  },
                ]),
              ),
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
        if (server) server = { ...server, logins: {}, files: [] };
      }),
    };
    const refreshLogin = vi.fn(async (_harness: PersonalHarness) => {});
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
      readLogin: async (harness) => logins[harness] ?? null,
      refreshLogin,
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
      refreshLogin,
      logins,
      setServer: (next: RemotePersonalEnvironment) => {
        server = next;
      },
    };
  }

  it("sends every local login by default and nothing else when allowed", async () => {
    const env = setup({
      logins: { "claude-code": login("claude-code", at(300)) },
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.puts).toHaveLength(1);
    expect(Object.keys(env.puts[0]?.logins ?? {})).toEqual(["claude-code"]);
    expect(env.puts[0]?.files).toEqual([]);
    expect(view.server).toBe("allowed");
    expect(view.lastSyncAt).toBe(at(0));
    expect(
      view.logins.map((entry) => [entry.harness, entry.available]),
    ).toEqual([
      ["claude-code", true],
      ["codex", false],
    ]);
    // Nothing changed: the next check does not send again.
    await env.sync.syncNow(env.target);
    expect(env.puts).toHaveLength(1);
  });

  it("sends listed files and re-sends when one changes", async () => {
    const env = setup({
      config: { logins: [], files: ["apps/api/.env.local", "missing"] },
      files: { "apps/api/.env.local": "B=2" },
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.puts[0]).toEqual({
      logins: {},
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
  });

  it("sends nothing where no Environment allows it and takes back an old copy", async () => {
    const env = setup({
      remote: remote({
        allowed: false,
        files: [
          { path: ".env", fingerprint: "x", bytes: 1, updatedAt: at(-1) },
        ],
      }),
      logins: { codex: login("codex", at(600)) },
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

  it("does not send while the config file is broken", async () => {
    const env = setup({
      config: '{"files": ["../outside"]}',
      logins: { codex: login("codex", at(600)) },
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.puts).toEqual([]);
    expect(view.configError).toContain("outside the project folder");
    expect(view.configExists).toBe(true);
  });

  it("refreshes an expiring Codex login locally and sends the new one", async () => {
    const env = setup({ logins: { codex: login("codex", at(30), "old") } });
    await env.sync.syncNow(env.target);
    env.setServer(
      remote({
        logins: {
          codex: {
            fingerprint: "s",
            expiresAt: at(30),
            updatedAt: at(-1),
            needsRefresh: true,
          },
        },
      }),
    );
    env.refreshLogin.mockImplementation(async () => {
      env.logins.codex = login("codex", at(14_400), "new");
    });
    await env.sync.syncNow(env.target);
    expect(env.refreshLogin).toHaveBeenCalledWith("codex");
    expect(env.puts.at(-1)?.logins.codex).toEqual({
      auth: JSON.stringify({ tokens: { access_token: "new" } }),
      expiresAt: at(14_400),
    });
    // Attempts are spaced: a server still asking does not loop the CLI.
    env.setServer(
      remote({
        logins: {
          codex: {
            fingerprint: "s",
            expiresAt: at(14_400),
            updatedAt: at(0),
            needsRefresh: true,
          },
        },
      }),
    );
    await env.sync.syncNow(env.target);
    expect(env.refreshLogin).toHaveBeenCalledTimes(1);
  });

  it("waits for Claude Code's refresh window instead of spending a request", async () => {
    const env = setup({
      logins: { "claude-code": login("claude-code", at(40)) },
      remote: remote({
        logins: {
          "claude-code": {
            fingerprint: "s",
            expiresAt: at(40),
            updatedAt: at(-1),
            needsRefresh: true,
          },
        },
      }),
    });
    const view = await env.sync.syncNow(env.target);
    expect(env.refreshLogin).not.toHaveBeenCalled();
    expect(
      view.logins.find((entry) => entry.harness === "claude-code")?.server
        ?.needsRefresh,
    ).toBe(false);
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
