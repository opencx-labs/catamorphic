import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nativeGit } from "@catamorphic/git";
import type {
  EnvironmentRuntimeBinding,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personalCredentialsDecision } from "../services/execution-environments-service.js";
import {
  deliverPersonalEnvironment,
  gitignoreLiteral,
  personalExcludeBlock,
  removePersonalEnvironment,
} from "../services/personal-environment-delivery.js";
import {
  PersonalEnvironmentInvalidError,
  personalFilePathProblem,
  personalFingerprint,
  type UnsealedPersonalEnvironment,
  validatePersonalEnvironment,
} from "../services/personal-environment-service.js";
import { ensureSandboxBaseline } from "../services/sandbox-git.js";
import { parseSnapshot } from "../services/sandbox-sync.js";

const execute = promisify(execFile);

const base64 = (text: string) => Buffer.from(text).toString("base64");

function refused(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof PersonalEnvironmentInvalidError)
      return [...error.issues];
    throw error;
  }
  return [];
}

describe("personal environment input (ADR 0184)", () => {
  it("accepts repository paths and refuses the rest", () => {
    for (const ok of [
      ".env",
      "apps/api/.env.local",
      "a b/c#d.txt",
      ".gitignore",
    ])
      expect(personalFilePathProblem(ok)).toBeUndefined();
    for (const bad of [
      "",
      "/etc/passwd",
      "C:/x",
      "../outside",
      "apps/../../x",
      "./.env",
      "apps//x",
      "apps/",
      ".git/config",
      "sub/.git/hooks/pre-commit",
      "a\\b",
      "line\nbreak",
    ])
      expect(personalFilePathProblem(bad), bad).toBeTruthy();
  });

  it("validates files", () => {
    const entries = validatePersonalEnvironment({
      files: [{ path: ".env", content: base64("A=1\n") }],
    });
    expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["file", ".env"],
    ]);
    expect(entries[0]?.content.toString()).toBe("A=1\n");
  });

  it("refuses the whole set with every reason", () => {
    const issues = refused(() =>
      validatePersonalEnvironment({
        files: [
          { path: "../x", content: base64("x") },
          { path: ".env", content: "%%%" },
          { path: "big", content: base64("x".repeat(256 * 1024 + 1)) },
          { path: "dup", content: base64("x") },
          { path: "dup", content: base64("y") },
        ],
      }),
    );
    expect(issues).toHaveLength(4);
    expect(issues.join("\n")).toMatch(/256 KiB/);
    expect(issues.join("\n")).toMatch(/listed twice/);
    expect(
      refused(() =>
        validatePersonalEnvironment({
          files: Array.from({ length: 51 }, (_, index) => ({
            path: `f${index}`,
            content: "",
          })),
        }),
      ),
    ).toContain("At most 50 files may be included");
  });
});

describe("where personal credentials may go (ADR 0184)", () => {
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
  const decide = (input: {
    flag?: boolean;
    owner?: string | null;
    runtime: EnvironmentRuntimeBinding;
    device?: "member";
  }) =>
    personalCredentialsDecision({
      environment: "dev",
      definition: {
        ...(input.flag === false ? {} : { personalCredentials: true }),
        ...(input.device ? { device: input.device } : {}),
      },
      owner: input.owner === undefined ? "ada@example.test" : input.owner,
      runtime: input.runtime,
    });

  it("needs the Environment's flag", () => {
    const decision = decide({
      flag: false,
      runtime: runtime({ isolation: "sandbox" }),
    });
    expect(decision).toMatchObject({ allowed: false });
    expect("reason" in decision && decision.reason).toContain(
      '"personalCredentials": true',
    );
  });

  it("refuses the project's own work", () => {
    const decision = decide({
      owner: null,
      runtime: runtime({ isolation: "sandbox" }),
    });
    expect("reason" in decision && decision.reason).toContain(
      "only a member's own chats",
    );
  });

  it("allows isolating placements and refuses shared processes", () => {
    expect(decide({ runtime: runtime({ isolation: "sandbox" }) }).allowed).toBe(
      true,
    );
    expect(decide({ runtime: runtime({}, true) }).allowed).toBe(true);
    expect(decide({ runtime: runtime(), device: "member" }).allowed).toBe(true);
    expect(
      decide({
        runtime: runtime({ capabilities: ["credentials.personal"] }),
      }).allowed,
    ).toBe(true);
    const shared = decide({ runtime: runtime() });
    expect("reason" in shared && shared.reason).toContain(
      "WORK_PERSONAL_CREDENTIALS=accept",
    );
  });
});

describe("gitignore patterns for personal files", () => {
  it("match exactly one path", () => {
    expect(gitignoreLiteral(".env")).toBe("/.env");
    expect(gitignoreLiteral("a[1]*?.txt")).toBe("/a\\[1]\\*\\?.txt");
    expect(gitignoreLiteral("!important")).toBe("/!important");
    expect(gitignoreLiteral("#notes")).toBe("/#notes");
    expect(gitignoreLiteral("trailing  ")).toBe("/trailing\\ \\ ");
    expect(personalExcludeBlock([".env"])).toBe(
      "# BEGIN Work personal files (ADR 0184)\n/.env\n# END Work personal files\n",
    );
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
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    },
    async downloadFile(_id, filePath) {
      return fs.readFile(real(filePath), "utf8");
    },
  };
}

function environment(
  files: Record<string, string>,
): UnsealedPersonalEnvironment {
  return {
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      content: Buffer.from(content),
      fingerprint: personalFingerprint(content),
    })),
  };
}

describe("personal files in a sandbox (ADR 0184)", () => {
  let root: string;
  let provider: SandboxProvider;
  const project = () => path.join(root, "workspace", "project");
  const snapshot = async () =>
    parseSnapshot(
      (
        await provider.executeCommand(
          "s",
          [
            "git_dir=$(git rev-parse --git-dir)",
            'export GIT_INDEX_FILE="$git_dir/work-sync-index"',
            'base=$(git rev-parse -q --verify "refs/work/synced^{tree}")',
            "git add -A",
            "tree=$(git write-tree)",
            'printf "%s\\n" "$tree"',
            'git -c core.quotePath=false diff-tree -r --no-renames --name-status "$base" "$tree"',
          ].join(" && "),
          { cwd: "/workspace/project" },
        )
      ).result,
    );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "work personal #"));
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await fs.mkdir(path.join(project(), "config"), { recursive: true });
    await fs.writeFile(path.join(project(), "app.ts"), "one\n");
    await fs.writeFile(path.join(project(), "config", "tracked.env"), "T=1\n");
    provider = directorySandbox(root);
    await ensureSandboxBaseline({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
      originUrl: null,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("places files outside everything that leaves the sandbox", async () => {
    const result = await deliverPersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
      environment: environment(
        {
          ".env": "SECRET=1\n",
          "apps/api/.env.local": "LOCAL=1\n",
          "config/tracked.env": "T=mine\n",
          "odd [name]*.env": "ODD=1\n",
        },
      ),
    });
    expect(result.refused).toEqual(["config/tracked.env"]);
    expect(result.delivered.map((entry) => entry.name).sort()).toEqual([
      ".env",
      "apps/api/.env.local",
      "odd [name]*.env",
    ]);
    expect(await fs.readFile(path.join(project(), ".env"), "utf8")).toBe(
      "SECRET=1\n",
    );
    // The tracked file keeps the repository's content.
    expect(
      await fs.readFile(path.join(project(), "config", "tracked.env"), "utf8"),
    ).toBe("T=1\n");
    const stat = await fs.stat(path.join(project(), ".env"));
    expect(stat.mode & 0o777).toBe(0o600);
    // Nothing personal reaches the sync-back snapshot, and an agent's
    // commit of everything leaves them out.
    await fs.writeFile(path.join(project(), "app.ts"), "two\n");
    expect((await snapshot())?.changes).toEqual([
      { path: "app.ts", kind: "modified" },
    ]);
    await nativeGit(project(), ["add", "-A"]);
    const staged = await nativeGit(project(), [
      "diff",
      "--cached",
      "--name-only",
    ]);
    expect(staged.trim()).toBe("app.ts");
  });

  it("keeps the agent's edits, replaces changed files, and removes dropped ones", async () => {
    const deliver = (files: Record<string, string>) =>
      deliverPersonalEnvironment({
        provider,
        sandboxId: "s",
        projectDir: "/workspace/project",
        environment: environment(files),
      });
    await deliver({ ".env": "A=1\n", "b.env": "B=1\n" });
    await fs.writeFile(path.join(project(), ".env"), "A=edited\n");
    const again = await deliver({ ".env": "A=1\n", "b.env": "B=1\n" });
    expect(again.delivered).toEqual([]);
    expect(await fs.readFile(path.join(project(), ".env"), "utf8")).toBe(
      "A=edited\n",
    );
    await deliver({ ".env": "A=2\n" });
    expect(await fs.readFile(path.join(project(), ".env"), "utf8")).toBe(
      "A=2\n",
    );
    await expect(fs.stat(path.join(project(), "b.env"))).rejects.toThrow();
    const exclude = await fs.readFile(
      path.join(project(), ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude.match(/BEGIN Work personal files/g)).toHaveLength(1);
    expect(exclude).toContain("/.env\n");
    expect(exclude).not.toContain("/b.env");

    await removePersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
    });
    await expect(fs.stat(path.join(project(), ".env"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(root, "workspace", ".work-session", "personal")),
    ).rejects.toThrow();
    // Safe to repeat.
    await removePersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
    });
  });
  it("never removes or replaces a path the repository came to track", async () => {
    const deliver = (files: Record<string, string>) =>
      deliverPersonalEnvironment({
        provider,
        sandboxId: "s",
        projectDir: "/workspace/project",
        environment: environment(files),
      });
    await deliver({ ".env": "A=1\n" });
    // A teammate commits the same path.
    await fs.writeFile(path.join(project(), ".env"), "SHARED=1\n");
    await nativeGit(project(), ["add", "-f", ".env"]);
    await nativeGit(project(), [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-m",
      "Share .env",
    ]);
    const again = await deliver({ ".env": "A=1\n" });
    expect(again.refused).toEqual([".env"]);
    expect(await fs.readFile(path.join(project(), ".env"), "utf8")).toBe(
      "SHARED=1\n",
    );
    await deliver({});
    await removePersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
    });
    expect(await fs.readFile(path.join(project(), ".env"), "utf8")).toBe(
      "SHARED=1\n",
    );
  });

  it("refuses paths through symbolic links and never writes or removes outside", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "target.txt"), "KEEP\n");
    await fs.symlink(outside, path.join(project(), "linked"));
    await fs.symlink(
      path.join(outside, "target.txt"),
      path.join(project(), ".env.local"),
    );
    const deliver = (files: Record<string, string>) =>
      deliverPersonalEnvironment({
        provider,
        sandboxId: "s",
        projectDir: "/workspace/project",
        environment: environment(files),
      });
    const result = await deliver({
      "linked/.env": "X=1\n",
      ".env.local": "Y=1\n",
      "sub/.env": "Z=1\n",
    });
    expect(result.unsafe.sort()).toEqual([".env.local", "linked/.env"]);
    expect(result.delivered.map((entry) => entry.name)).toEqual(["sub/.env"]);
    await expect(fs.stat(path.join(outside, ".env"))).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, "target.txt"), "utf8")).toBe(
      "KEEP\n",
    );
    // A delivered path whose folder becomes a link is left alone.
    await fs.writeFile(path.join(outside, ".env"), "OUTSIDE=1\n");
    await fs.rm(path.join(project(), "sub"), { recursive: true });
    await fs.symlink(outside, path.join(project(), "sub"));
    await deliver({});
    await removePersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
    });
    expect(await fs.readFile(path.join(outside, ".env"), "utf8")).toBe(
      "OUTSIDE=1\n",
    );
  });

  it("takes out the exclude block on removal", async () => {
    // Nothing delivered yet: removal leaves the repository alone.
    await removePersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
    });
    await deliverPersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
      environment: environment({ ".env": "A=1\n" }),
    });
    expect(await fs.readFile(path.join(project(), ".env"), "utf8")).toBe(
      "A=1\n",
    );
    await removePersonalEnvironment({
      provider,
      sandboxId: "s",
      projectDir: "/workspace/project",
    });
    const exclude = await fs.readFile(
      path.join(project(), ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).not.toContain("Work personal files");
  });
});
