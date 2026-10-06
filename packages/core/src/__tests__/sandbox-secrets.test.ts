import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EnvironmentRuntimeBinding,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  personalCredentialsDecision,
  placementIsolatesOwner,
} from "../services/execution-environments-service.js";
import {
  deliverSandboxSecrets,
  removeSandboxSecrets,
  sandboxSecretsFile,
  sandboxSecretsNote,
  sandboxSecretsPrelude,
} from "../services/sandbox-secrets.js";
import { reservedSandboxVariable } from "../services/secrets-service.js";

const execute = promisify(execFile);

/*
 * An Environment's secrets in a sandbox (ADR 0206): where they may go, the
 * file shells and the runner load, and what the agent is told about the
 * ones it did not get.
 */

describe("which placements isolate the work's owner", () => {
  const runtime = (
    overrides: Partial<EnvironmentRuntimeBinding["descriptor"]> = {},
    servesOnlyOwner?: boolean,
  ): EnvironmentRuntimeBinding => ({
    descriptor: {
      id: "node",
      label: "node",
      trust: "managed",
      isolation: "process",
      workloads: ["agent"],
      agentTopologies: ["controller"],
      capabilities: [],
      resources: {},
      ...overrides,
    },
    ...(servesOnlyOwner ? { servesOnlyOwner } : {}),
  });
  const isolates = (input: {
    owner: string | null;
    runtime: EnvironmentRuntimeBinding;
    device?: "member";
  }) =>
    placementIsolatesOwner({
      definition: input.device ? { device: input.device } : {},
      owner: input.owner,
      runtime: input.runtime,
    });

  it("isolates a member's work as personal credentials need", () => {
    for (const owner of ["ada", null]) {
      expect(
        isolates({ owner, runtime: runtime({ isolation: "sandbox" }) }),
      ).toBe(true);
      // A machine only this owner's work reaches: the member, or the project.
      expect(isolates({ owner, runtime: runtime({}, true) })).toBe(true);
      expect(isolates({ owner, runtime: runtime() })).toBe(false);
    }
    expect(
      isolates({ owner: "ada", runtime: runtime(), device: "member" }),
    ).toBe(true);
    expect(
      isolates({
        owner: "ada",
        runtime: runtime({ capabilities: ["credentials.personal"] }),
      }),
    ).toBe(true);
    // An operator's acceptance is about members' own credentials, never
    // the project's work on shared processes.
    expect(
      isolates({
        owner: null,
        runtime: runtime({ capabilities: ["credentials.personal"] }),
      }),
    ).toBe(false);
  });

  it("is what personal credentials reuse", () => {
    const decide = (runtimeBinding: EnvironmentRuntimeBinding) =>
      personalCredentialsDecision({
        environment: "dev",
        definition: { personalCredentials: true },
        owner: "ada",
        runtime: runtimeBinding,
      }).allowed;
    expect(decide(runtime({ isolation: "sandbox" }))).toBe(true);
    expect(decide(runtime({}, true))).toBe(true);
    expect(decide(runtime())).toBe(false);
  });
});

describe("what the agent is told about secrets it did not get", () => {
  it("names who can set them, for a member's chat and the project's", () => {
    const member = sandboxSecretsNote({
      environment: "dev",
      owner: "ada",
      missing: [
        { name: "CLICKHOUSE_API_KEY", reason: "unset" },
        { name: "STRIPE_KEY", reason: "unset" },
        { name: "TYPO_KEY", reason: "undeclared" },
        { name: "PATH", reason: "reserved" },
        { name: "SIGNING_SECRET", reason: "webhook" },
      ],
    });
    expect(member).toContain(
      "CLICKHOUSE_API_KEY and STRIPE_KEY are not set in this workspace",
    );
    expect(member).toContain("set their own value under Secrets in Work");
    expect(member).toContain("someone who manages this project's secrets");
    expect(member).toContain("Environment 'dev' lists TYPO_KEY");
    expect(member).toContain("PATH would replace a variable");
    expect(member).toContain("SIGNING_SECRET verifies webhook deliveries");
    expect(member).not.toMatch(/[–—]/);
    const project = sandboxSecretsNote({
      environment: "dev",
      owner: null,
      missing: [{ name: "SENTRY_DSN", reason: "unset" }],
    });
    expect(project).toContain("the project has no shared value for it");
    expect(project).not.toContain("their own value");
    expect(
      sandboxSecretsNote({ environment: "dev", owner: null, missing: [] }),
    ).toBeUndefined();
  });

  it("says which values are too short to hide in the transcript", () => {
    const note = sandboxSecretsNote({
      environment: "dev",
      owner: "ada",
      missing: [],
      unmasked: ["PIN"],
    });
    expect(note).toContain("PIN is set, but its value is shorter than 6");
    expect(note).toContain("Never print, echo or write it anywhere");
  });

  it("never sets what shells, Git, Node, TLS or the harnesses rely on", () => {
    for (const name of [
      "PATH",
      "NODE_OPTIONS",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_12",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "ALL_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "SHELLOPTS",
      "BASHOPTS",
      "PS4",
      "PROMPT_COMMAND",
      "TMPDIR",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
    ])
      expect(reservedSandboxVariable(name), name).toBe(true);
    for (const name of ["CLICKHOUSE_API_KEY", "GIT_TOKEN", "NODE_ENV"])
      expect(reservedSandboxVariable(name), name).toBe(false);
  });
});

/** Where each upload landed, and its folder's mode as it did. */
const uploads: Array<{ path: string; parentMode: number | null }> = [];

/** A sandbox that is a directory on this machine, like local-process. */
function directorySandbox(root: string): SandboxProvider {
  const real = (virtual: string) =>
    path.join(root, virtual.replace(/^\/workspace/, "workspace"));
  const unused = () => {
    throw new Error("unused");
  };
  return {
    workspaceRoot: "/workspace",
    createSandbox: unused,
    startSandbox: unused,
    stopSandbox: unused,
    destroySandbox: unused,
    getSandboxStatus: unused,
    gitClone: unused,
    gitCheckout: unused,
    async executeCommand(_id, command, opts) {
      try {
        const { stdout } = await execute("/bin/bash", ["-c", command], {
          cwd: real(opts?.cwd ?? "/workspace"),
          env: { PATH: process.env.PATH ?? "", HOME: path.join(root, "home") },
        });
        return { exitCode: 0, result: stdout };
      } catch (error) {
        const failure = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: failure.code ?? 1,
          result: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
        };
      }
    },
    async uploadFiles(_id, files, basePath) {
      for (const [name, content] of Object.entries(files)) {
        const target = path.join(real(basePath), name);
        // What anyone else in the sandbox could read while it lands.
        const parent = await fs
          .stat(path.dirname(target))
          .then((stat) => stat.mode & 0o777)
          .catch(() => null);
        uploads.push({ path: target, parentMode: parent });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    },
    async downloadFile(_id, filePath) {
      return fs.readFile(real(filePath), "utf8");
    },
  };
}

describe("the secrets file in a sandbox", () => {
  let root: string;
  let provider: SandboxProvider;
  const target = () => ({
    provider,
    sandboxId: "s",
    projectDir: "/workspace/project",
  });
  const file = () =>
    path.join(root, "workspace", ".work-session", "env", "secrets.sh");

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "work secrets #"));
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await fs.mkdir(path.join(root, "workspace", "project"), {
      recursive: true,
    });
    provider = directorySandbox(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is the sandbox user's alone, outside the project, and loads in a shell", async () => {
    const first = await deliverSandboxSecrets({
      ...target(),
      variables: { CLICKHOUSE_API_KEY: "ch-'key'\n2", SENTRY_DSN: "https://x" },
    });
    expect(first.changed).toBe(true);
    // The value travelled into a folder only the sandbox user can open.
    expect(uploads.at(-1)?.path).toContain("/env/incoming/");
    expect(uploads.at(-1)?.parentMode).toBe(0o700);
    expect(sandboxSecretsFile({ workspaceRoot: "/workspace" })).toBe(
      "/workspace/.work-session/env/secrets.sh",
    );
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file()))).mode & 0o777).toBe(0o700);
    // Nothing is left beside it but its fingerprint.
    expect((await fs.readdir(path.dirname(file()))).sort()).toEqual([
      "secrets.sh",
      "secrets.sha256",
    ]);
    expect(await fs.readdir(path.join(root, "workspace", "project"))).toEqual(
      [],
    );
    // Setup and terminals load it from the project folder.
    const loaded = await provider.executeCommand(
      "s",
      `${sandboxSecretsPrelude()}\nprintf '%s|%s' "$CLICKHOUSE_API_KEY" "$SENTRY_DSN"`,
      { cwd: "/workspace/project" },
    );
    expect(loaded.result).toBe("ch-'key'\n2|https://x");
    // BASH_ENV loads it in non-interactive shells. (Bash skips it when its
    // standard input is a socket, as Node's pipes are, which is why the
    // runner also passes the variables themselves.)
    const shell = spawnSync("/bin/bash", ["-c", 'printf "%s" "$SENTRY_DSN"'], {
      env: { PATH: process.env.PATH ?? "", BASH_ENV: file() },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(shell.stdout).toBe("https://x");

    const same = await deliverSandboxSecrets({
      ...target(),
      variables: { CLICKHOUSE_API_KEY: "ch-'key'\n2", SENTRY_DSN: "https://x" },
    });
    expect(same.changed).toBe(false);
    const changed = await deliverSandboxSecrets({
      ...target(),
      variables: { CLICKHOUSE_API_KEY: "rotated" },
    });
    expect(changed.changed).toBe(true);
    expect(await fs.readFile(file(), "utf8")).toBe(
      "export CLICKHOUSE_API_KEY='rotated'\n",
    );
  });

  it("is removed, safely again and again, and then loads nothing", async () => {
    await removeSandboxSecrets(target());
    await deliverSandboxSecrets({ ...target(), variables: { A_KEY: "value" } });
    await removeSandboxSecrets(target());
    await removeSandboxSecrets(target());
    await expect(fs.stat(file())).rejects.toThrow();
    const loaded = await provider.executeCommand(
      "s",
      `set -e\n${sandboxSecretsPrelude()}\nprintf '%s' "\${A_KEY:-unset}"`,
      { cwd: "/workspace/project" },
    );
    expect(loaded).toEqual({ exitCode: 0, result: "unset" });
    // Delivered again after removal, the change is audited again.
    expect(
      (
        await deliverSandboxSecrets({
          ...target(),
          variables: { A_KEY: "value" },
        })
      ).changed,
    ).toBe(true);
  });
});
