import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nativeGit } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advertisedDefaultBranch,
  FLUSH_PKT,
  normalizeRepositoryPath,
  parseReceivePackCommands,
  pktLine,
  readPktSection,
  receivePackRefusal,
  refMatches,
  repositoryBelow,
  reviewPush,
} from "../services/git-gateway.js";
import {
  configureSandboxGateway,
  ensureSandboxBaseline,
} from "../services/sandbox-git.js";
import { parseSnapshot } from "../services/sandbox-sync.js";
import { workspaceMoveNote } from "../services/session-workspaces.js";

const execute = promisify(execFile);
const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function pushBody(
  commands: Array<[string, string, string]>,
  capabilities = "report-status side-band-64k",
): Uint8Array {
  const lines = commands.map(([oldId, newId, ref], index) =>
    pktLine(
      index === 0
        ? `${oldId} ${newId} ${ref}\0${capabilities}\n`
        : `${oldId} ${newId} ${ref}\n`,
    ),
  );
  const pack = new TextEncoder().encode("PACK....");
  const parts = [...lines, FLUSH_PKT, pack];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("Git gateway protocol (ADR 0175)", () => {
  it("reads receive-pack commands up to the flush and leaves the pack", () => {
    const body = pushBody([
      [A, B, "refs/heads/work/fix"],
      [B, ZERO, "refs/heads/old"],
    ]);
    const section = readPktSection(body);
    expect(section).not.toBeNull();
    expect(decode(body.subarray(section?.end))).toBe("PACK....");
    expect(parseReceivePackCommands(section?.lines ?? [])).toEqual({
      commands: [
        { oldId: A, newId: B, ref: "refs/heads/work/fix" },
        { oldId: B, newId: ZERO, ref: "refs/heads/old" },
      ],
      capabilities: ["report-status", "side-band-64k"],
    });
    // An incomplete buffer has no section yet.
    expect(readPktSection(body.subarray(0, 20))).toBeNull();
  });

  it("refuses shallow lines, certificates, and anything it cannot read", () => {
    expect(() =>
      parseReceivePackCommands([new TextEncoder().encode(`shallow ${A}\n`)]),
    ).toThrow(/cannot read/);
  });

  it("allows work/ branches and named patterns, never the default branch or deletes", () => {
    expect(refMatches("refs/heads/work/fix", "work/*")).toBe(true);
    expect(refMatches("refs/heads/work/a/b", "work/*")).toBe(true);
    expect(refMatches("refs/heads/main", "work/*")).toBe(false);
    expect(refMatches("refs/tags/v1.2", "refs/tags/v*")).toBe(true);
    expect(refMatches("refs/heads/workshop", "work/*")).toBe(false);
    expect(
      reviewPush({
        commands: [{ oldId: A, newId: B, ref: "refs/heads/work/fix" }],
        patterns: ["work/*"],
        defaultBranch: "refs/heads/main",
      }),
    ).toBeNull();
    const refused = reviewPush({
      commands: [
        { oldId: A, newId: B, ref: "refs/heads/main" },
        { oldId: A, newId: ZERO, ref: "refs/heads/work/old" },
        { oldId: A, newId: B, ref: "refs/heads/feature" },
      ],
      patterns: ["work/*", "main"],
      defaultBranch: "refs/heads/main",
    });
    expect(refused?.get("refs/heads/main")).toMatch(/default branch/);
    expect(refused?.get("refs/heads/work/old")).toMatch(/delete/);
    expect(refused?.get("refs/heads/feature")).toMatch(/may push only/);
  });

  it("answers a refusal as report-status over side-band so git prints it", () => {
    const answer = receivePackRefusal({
      commands: [{ oldId: A, newId: B, ref: "refs/heads/main" }],
      capabilities: ["report-status", "side-band-64k"],
      reasons: new Map([["refs/heads/main", "not allowed"]]),
    });
    const text = decode(answer);
    expect(text).toContain("\u0002not allowed\n");
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ng refs/heads/main not allowed\n");
    expect(text.endsWith("0000")).toBe(true);
    const plain = decode(
      receivePackRefusal({
        commands: [{ oldId: A, newId: B, ref: "refs/heads/main" }],
        capabilities: ["report-status"],
        reasons: new Map([["refs/heads/main", "not allowed"]]),
      }),
    );
    expect(plain).toBe(
      "000eunpack ok\n0023ng refs/heads/main not allowed\n0000",
    );
  });

  it("finds the default branch in an upload-pack advertisement", () => {
    const encoder = new TextEncoder();
    const parts = [
      pktLine("# service=git-upload-pack\n"),
      FLUSH_PKT,
      pktLine(
        `${A} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n`,
      ),
      pktLine(`${A} refs/heads/trunk\n`),
      FLUSH_PKT,
    ];
    const body = encoder.encode(parts.map((part) => decode(part)).join(""));
    expect(advertisedDefaultBranch(body)).toBe("refs/heads/trunk");
  });

  it("normalizes repository paths and refuses traversal", () => {
    expect(normalizeRepositoryPath("/org/repo.git/")).toBe("org/repo");
    expect(() => normalizeRepositoryPath("org/../x")).toThrow();
    expect(() => normalizeRepositoryPath("")).toThrow();
    expect(
      repositoryBelow("https://github.com/org/repo.git", "https://github.com/"),
    ).toBe("org/repo");
    expect(
      repositoryBelow("https://gitlab.com/org/repo", "https://github.com/"),
    ).toBeNull();
  });
});

describe("workspace move notes (ADR 0178)", () => {
  it("tells the agent the old and new heads and what changed", () => {
    const note = workspaceMoveNote({
      from: { ref: "refs/pull/4/head", commit: A },
      to: { ref: "refs/pull/4/head", commit: B },
      update: "rebase",
      outcome: { status: "moved", head: B },
      changed: { files: ["a.ts", "b.ts"], total: 5 },
    });
    expect(note).toContain(`from refs/pull/4/head at ${A.slice(0, 12)}`);
    expect(note).toContain(`to refs/pull/4/head at ${B.slice(0, 12)}`);
    expect(note).toContain("a.ts, b.ts and 3 more");
    expect(
      workspaceMoveNote({
        from: { ref: "main", commit: A },
        to: { ref: "main", commit: B },
        update: "rebase",
        outcome: { status: "conflict", head: A, files: ["x.ts"] },
        changed: null,
      }),
    ).toMatch(/conflicts in x\.ts.*refs\/work\/base/s);
  });
});

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
          env: {
            PATH: process.env.PATH ?? "",
            HOME: path.join(root, "home"),
          },
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
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    },
    async downloadFile(_id, filePath) {
      return fs.readFile(real(filePath), "utf8");
    },
  };
}

describe("sandbox Git (ADRs 0175, 0178)", () => {
  let root: string;
  let provider: SandboxProvider;
  const project = () => path.join(root, "workspace", "project");

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "work-sandbox-git-"));
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await fs.mkdir(project(), { recursive: true });
    await fs.writeFile(path.join(project(), "app.ts"), "one\n");
    provider = directorySandbox(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("snapshots changes the agent committed as well as uncommitted ones", async () => {
    await ensureSandboxBaseline({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
      originUrl: "https://git.example.test/org/repo.git",
    });
    expect(
      (await nativeGit(project(), ["remote", "get-url", "origin"])).trim(),
    ).toBe("https://git.example.test/org/repo.git");
    await fs.writeFile(path.join(project(), "app.ts"), "two\n");
    await nativeGit(project(), [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@example.test",
      "commit",
      "-qam",
      "agent commit",
    ]);
    await fs.writeFile(path.join(project(), "new.ts"), "x\n");
    const snapshot = await provider.executeCommand(
      "s",
      [
        "git_dir=$(git rev-parse --git-dir)",
        'export GIT_INDEX_FILE="$git_dir/work-sync-index"',
        'base=$(git rev-parse -q --verify "refs/work/synced^{tree}")',
        "git add -A",
        "tree=$(git write-tree)",
        'printf "%s\\n" "$tree"',
        'git diff-tree -r -z --no-renames --name-status "$base" "$tree"',
      ].join(" && "),
      { cwd: "/workspace/project" },
    );
    const parsed = parseSnapshot(snapshot.result);
    expect(parsed?.changes).toEqual([
      { path: "app.ts", kind: "modified" },
      { path: "new.ts", kind: "modified" },
    ]);
    // The agent's own index and branch are untouched by the snapshot.
    expect((await nativeGit(project(), ["status", "--porcelain"])).trim()).toBe(
      "?? new.ts",
    );
  });

  it("configures the gateway with a credential helper that answers with the grant", async () => {
    await ensureSandboxBaseline({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
      originUrl: null,
    });
    await configureSandboxGateway({
      provider,
      sandboxId: "s",
      gatewayGitUrl: "http://127.0.0.1:9/api/gateway/git",
      aliases: [
        {
          alias: "code",
          grant: "grant-one",
          remoteBaseUrls: ["https://git.example.test/"],
        },
      ],
    });
    const env = { PATH: process.env.PATH ?? "", HOME: path.join(root, "home") };
    const rewritten = await execute(
      "git",
      ["ls-remote", "--get-url", "https://git.example.test/org/repo.git"],
      { cwd: project(), env },
    );
    expect(rewritten.stdout.trim()).toBe(
      "http://127.0.0.1:9/api/gateway/git/code/org/repo.git",
    );
    const fill = () =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          "git",
          ["credential", "fill"],
          { cwd: project(), env: { ...env, GIT_TERMINAL_PROMPT: "0" } },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin?.end(
          "protocol=http\nhost=127.0.0.1:9\npath=api/gateway/git/code/org/repo.git\n\n",
        );
      });
    expect(await fill()).toContain("password=grant-one");
    await configureSandboxGateway({
      provider,
      sandboxId: "s",
      gatewayGitUrl: "http://127.0.0.1:9/api/gateway/git",
      aliases: [
        {
          alias: "code",
          grant: "grant-two",
          remoteBaseUrls: ["https://git.example.test/"],
        },
      ],
      renewOnly: true,
    });
    expect(await fill()).toContain("password=grant-two");
  });
});
