import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { push } from "../git-sync.js";
import { InMemoryObjectStore } from "../in-memory-object-store.js";
import { nativeGit, nativeGitBytes } from "../native-git.js";
import { ObjectRemoteBackend } from "../object-remote-backend.js";
import { ProjectManager } from "../project-manager.js";
import {
  checkpointMessage,
  isSessionBranchName,
  parseCheckpointMessage,
  sessionBranchName,
} from "../session-checkpoint.js";
import { buildSeedPack, seedPackInstallScript } from "../workspace-mirror.js";
import {
  assertSavedTree,
  ReceivedPack,
  WorkspaceSaveError,
} from "../workspace-save.js";

const execute = promisify(execFile);
const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";
const SESSION = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const AUTHOR = { name: "Work", email: "system@work.software" };
const agent = ["-c", "user.name=Agent", "-c", "user.email=agent@example.test"];
const HEAD = "a".repeat(40);

/** A raw Git tree: `<mode> <name>NUL<id>` for each entry. */
function rawTree(entries: Array<{ mode: string; name: string }>): Uint8Array {
  return new Uint8Array(
    Buffer.concat(
      entries.flatMap((entry) => [
        Buffer.from(`${entry.mode} ${entry.name}`),
        Buffer.from([0]),
        Buffer.alloc(20, 7),
      ]),
    ),
  );
}

describe("a checkpoint's record (ADR 0342)", () => {
  it("names the agent's branch, HEAD and pushed branch as trailers", () => {
    const message = checkpointMessage({
      message: "Fix the parser\n\nWork-Head: forged",
      work: {
        head: HEAD,
        branch: "feature/x",
        pushed: { branch: "work/feature-x-0a1b2c3d", commit: "b".repeat(40) },
      },
    });
    expect(message.split("\n")[0]).toBe("Fix the parser");
    expect(parseCheckpointMessage(message)).toEqual({
      head: HEAD,
      branch: "feature/x",
      pushed: { branch: "work/feature-x-0a1b2c3d", commit: "b".repeat(40) },
    });
    expect(
      parseCheckpointMessage(
        checkpointMessage({
          message: "",
          work: { head: HEAD, branch: "main" },
        }),
      ),
    ).toEqual({ head: HEAD, branch: "main" });
  });

  it("reads nothing from a commit that is not a checkpoint", () => {
    for (const message of [
      "Initial commit",
      "Turn\n\nSigned-off-by: someone",
      `Work-Head: ${HEAD}\nWork-Branch: main`,
      `Turn\n\nWork-Branch: main\nWork-Head: short`,
      `Turn\n\nWork-Branch: a..b\nWork-Head: ${HEAD}`,
    ])
      expect(parseCheckpointMessage(message), message).toBeNull();
  });

  it("refuses a branch name Git would not take, or that reads as an option", () => {
    for (const name of ["main", "feature/x", "work/0a1b2c3d", "fix-1.2"])
      expect(isSessionBranchName(name), name).toBe(true);
    for (const name of [
      "",
      "-x",
      "a b",
      "a..b",
      "a:b",
      "+main",
      "x.lock",
      "a\nb",
      "HEAD",
      "refs/heads/../x",
      "a".repeat(256),
    ])
      expect(isSessionBranchName(name), JSON.stringify(name)).toBe(false);
    expect(() =>
      checkpointMessage({ message: "x", work: { head: HEAD, branch: "a b" } }),
    ).toThrow(/cannot record the branch/);
    expect(sessionBranchName(SESSION)).toBe("work/0a1b2c3d");
  });
});

describe("the trees a saved commit may hold (ADR 0342)", () => {
  it("takes folders, files, executables, links and nested repositories", () => {
    expect(() =>
      assertSavedTree({
        tree: rawTree([
          { mode: "40000", name: "src" },
          { mode: "100644", name: "notes é.txt" },
          { mode: "100755", name: "run.sh" },
          { mode: "120000", name: "link" },
          { mode: "160000", name: "vendor" },
        ]),
        idBytes: 20,
      }),
    ).not.toThrow();
    expect(() =>
      assertSavedTree({ tree: new Uint8Array(), idBytes: 20 }),
    ).not.toThrow();
  });

  it("refuses names that leave the checkout or enter a Git directory", () => {
    for (const name of ["..", ".", ".git", ".GIT", "git~1", ".git ", "a/b"])
      expect(
        () =>
          assertSavedTree({
            tree: rawTree([{ mode: "100644", name }]),
            idBytes: 20,
          }),
        JSON.stringify(name),
      ).toThrow(WorkspaceSaveError);
  });

  it("refuses a mode that is not a folder, file, link or nested repository", () => {
    for (const mode of ["100664", "100777", "040000", "20000", "0", "100600"])
      expect(
        () =>
          assertSavedTree({
            tree: rawTree([{ mode, name: "file" }]),
            idBytes: 20,
          }),
        mode,
      ).toThrow(/mode|cannot read/);
  });

  it("refuses a tree that is cut short", () => {
    const whole = rawTree([{ mode: "100644", name: "file" }]);
    expect(() =>
      assertSavedTree({
        tree: whole.subarray(0, whole.length - 3),
        idBytes: 20,
      }),
    ).toThrow(/cannot read/);
  });
});

describe("the commits a save brings (ADR 0342)", () => {
  let dir: string;
  let sandbox: string;
  let copy: string;
  let base: string;

  const git = (cwd: string, args: readonly string[]) =>
    nativeGit(cwd, args).then((output) => output.trim());
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(sandbox, name)), {
        recursive: true,
      });
      await fs.writeFile(path.join(sandbox, name), content);
    }
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, [...agent, "commit", "-q", "-m", message]);
    return git(sandbox, ["rev-parse", "HEAD"]);
  };
  /** The pack a sandbox sends: what `head` reaches that `known` does not. */
  const packOf = async (
    head: string,
    known: readonly string[],
    from = sandbox,
  ): Promise<Uint8Array> => {
    const objects = await nativeGitBytes(from, [
      "rev-list",
      "--objects",
      "--no-object-names",
      head,
      "--not",
      ...known,
    ]);
    return nativeGitBytes(from, ["pack-objects", "--stdout", "-q"], objects);
  };
  const receive = (pack: Uint8Array) =>
    ReceivedPack.receive({
      objectFormat: "sha1",
      borrow: copy,
      chunks: (async function* () {
        yield pack;
      })(),
    });
  /** Write a raw object of any shape into the sandbox, as a hostile one can. */
  const hashObject = async (type: string, content: Uint8Array) =>
    Buffer.from(
      await nativeGitBytes(
        sandbox,
        ["hash-object", "-t", type, "-w", "--stdin", "--literally"],
        content,
      ),
    )
      .toString("utf8")
      .trim();
  const hostileTree = async (mode: string, name: string) => {
    const blob = await hashObject("blob", new TextEncoder().encode("x"));
    return hashObject(
      "tree",
      new Uint8Array(
        Buffer.concat([
          Buffer.from(`${mode} ${name}`),
          Buffer.from([0]),
          Buffer.from(blob, "hex"),
        ]),
      ),
    );
  };
  const commitOf = (tree: string, parents: readonly string[]) =>
    git(sandbox, [
      ...agent,
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      "hostile",
    ]);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-history-"));
    sandbox = path.join(dir, "sandbox");
    copy = path.join(dir, "copy");
    await fs.mkdir(sandbox);
    await git(sandbox, ["init", "-q", "-b", "main"]);
    base = await commit({ "readme.md": "hello\n" }, "Base");
    // The control plane's copy holds the base and nothing after it.
    await git(dir, ["clone", "-q", sandbox, copy]);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("checks new commits and unpacks them loose into the copy", async () => {
    const first = await commit({ "src/app.ts": "one\n" }, "First");
    const head = await commit({ "src/app.ts": "two\n" }, "Second");
    const pack = await receive(await packOf(head, [base]));
    try {
      expect(
        await pack.assertHistory({
          head,
          known: [base],
          maxCommits: 10,
          maxBytes: 1024 * 1024,
        }),
      ).toEqual({ commits: [head, first] });
      await pack.unpackHistory({ repoPath: copy, head, known: [base] });
    } finally {
      await pack.dispose();
    }
    expect(await git(copy, ["log", "--format=%s", head])).toBe(
      "Second\nFirst\nBase",
    );
    expect(await git(copy, ["show", `${head}:src/app.ts`])).toBe("two");
    // Loose objects only: nothing a later reader must load as a pack.
    expect(
      (await fs.readdir(path.join(copy, ".git/objects/pack"))).filter((file) =>
        file.endsWith(".pack"),
      ),
    ).toHaveLength(
      (
        await fs
          .readdir(path.join(sandbox, ".git/objects/pack"))
          .catch(() => [])
      ).filter((file) => file.endsWith(".pack")).length,
    );
    await git(copy, ["fsck", "--strict", "--no-dangling"]);
  });

  it("takes a head that moved back to a commit already kept, with nothing to unpack", async () => {
    const first = await commit({ "a.txt": "a\n" }, "First");
    const head = await commit({ "a.txt": "b\n" }, "Second");
    const forward = await receive(await packOf(head, [base]));
    try {
      await forward.assertHistory({
        head,
        known: [base],
        maxCommits: 10,
        maxBytes: 1024 * 1024,
      });
      await forward.unpackHistory({ repoPath: copy, head, known: [base] });
    } finally {
      await forward.dispose();
    }
    // The agent reset its branch one commit back: the save carries a file,
    // and no commit the copy lacks.
    const back = await receive(
      await nativeGitBytes(
        sandbox,
        ["pack-objects", "--stdout", "-q"],
        new TextEncoder().encode(
          `${await git(sandbox, ["rev-parse", `${first}:a.txt`])}\n`,
        ),
      ),
    );
    try {
      expect(
        await back.assertHistory({
          head: first,
          known: [base, head],
          maxCommits: 10,
          maxBytes: 1024,
        }),
      ).toEqual({ commits: [] });
      await back.unpackHistory({
        repoPath: copy,
        head: first,
        known: [base, head],
      });
    } finally {
      await back.dispose();
    }
    await git(copy, ["cat-file", "-e", `${first}^{commit}`]);
  });

  it("reports nothing new for a head the copy already holds", async () => {
    const pack = await receive(await packOf(base, []));
    try {
      expect(
        await pack.assertHistory({
          head: base,
          known: [base],
          maxCommits: 10,
          maxBytes: 1024,
        }),
      ).toEqual({ commits: [] });
    } finally {
      await pack.dispose();
    }
  });

  it("refuses a commit whose tree names .., a Git directory or a bad mode", async () => {
    for (const [mode, name] of [
      ["100644", ".."],
      ["40000", ".git"],
      ["100644", ".GIT"],
      ["100666", "wide-open"],
      ["100644", "a/b"],
    ] as const) {
      const head = await commitOf(await hostileTree(mode, name), [base]);
      // The pack names the objects outright: Git's own walk refuses some.
      const tree = await git(sandbox, ["rev-parse", `${head}^{tree}`]);
      const blob = await hashObject("blob", new TextEncoder().encode("x"));
      const bytes = await nativeGitBytes(
        sandbox,
        ["pack-objects", "--stdout", "-q"],
        new TextEncoder().encode(`${head}\n${tree}\n${blob}\n`),
      );
      const outcome = await receive(bytes).then(
        async (pack) => {
          try {
            await pack.assertHistory({
              head,
              known: [base],
              maxCommits: 10,
              maxBytes: 1024 * 1024,
            });
            await pack.unpackHistory({ repoPath: copy, head, known: [base] });
            return "kept";
          } catch (error) {
            return error;
          } finally {
            await pack.dispose();
          }
        },
        (error: unknown) => error,
      );
      expect(outcome, `${mode} ${name}`).toBeInstanceOf(WorkspaceSaveError);
      await expect(git(copy, ["cat-file", "-e", head])).rejects.toThrow();
    }
  });

  it("refuses commits whose history does not arrive whole", async () => {
    const first = await commit({ "a.txt": "a\n" }, "First");
    const head = await commit({ "a.txt": "b\n" }, "Second");
    // Only the newest commit travels: its parent is nowhere.
    const pack = await receive(await packOf(head, [first]));
    try {
      await expect(
        pack.assertHistory({
          head,
          known: [base],
          maxCommits: 10,
          maxBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/history that did not arrive/);
    } finally {
      await pack.dispose();
    }
  });

  it("refuses a commit whose tree did not arrive", async () => {
    const head = await commit({ "a.txt": "a\n" }, "First");
    const bytes = await nativeGitBytes(
      sandbox,
      ["pack-objects", "--stdout", "-q"],
      new TextEncoder().encode(`${head}\n`),
    );
    const pack = await receive(bytes);
    try {
      await expect(
        pack.assertHistory({
          head,
          known: [base],
          maxCommits: 10,
          maxBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(WorkspaceSaveError);
    } finally {
      await pack.dispose();
    }
  });

  it("refuses history that does not start from what the copy holds", async () => {
    const tree = await git(sandbox, ["rev-parse", `${base}^{tree}`]);
    const orphan = await commitOf(tree, []);
    const head = await commitOf(tree, [orphan]);
    const pack = await receive(await packOf(head, [base]));
    try {
      await expect(
        pack.assertHistory({
          head,
          known: [base],
          maxCommits: 10,
          maxBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/no parent/);
    } finally {
      await pack.dispose();
    }
  });

  it("bounds the commits and bytes one save may bring", async () => {
    await commit({ "a.txt": "1\n" }, "One");
    await commit({ "a.txt": "2\n" }, "Two");
    const head = await commit({ "big.bin": "x".repeat(4096) }, "Three");
    const pack = await receive(await packOf(head, [base]));
    try {
      await expect(
        pack.assertHistory({
          head,
          known: [base],
          maxCommits: 2,
          maxBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/more than 2 commits/);
      await expect(
        pack.assertHistory({
          head,
          known: [base],
          maxCommits: 10,
          maxBytes: 2048,
        }),
      ).rejects.toThrow(/MiB of commits/);
      await expect(
        pack.assertHistory({
          head: "not-a-commit",
          known: [base],
          maxCommits: 10,
          maxBytes: 2048,
        }),
      ).rejects.toThrow(/invalid commit/);
    } finally {
      await pack.dispose();
    }
  });

  it("builds a pack that restores a branch, its commits and its uncommitted tree", async () => {
    await git(sandbox, ["checkout", "-q", "-b", "feature/x"]);
    const head = await commit({ "src/app.ts": "one\n" }, "Agent commit");
    // The working tree as a save snapshots it: more than the commit holds.
    await fs.writeFile(path.join(sandbox, "untracked.txt"), "new\n");
    await fs.writeFile(path.join(sandbox, "readme.md"), "edited\n");
    await fs.rm(path.join(sandbox, "src/app.ts"));
    await fs.symlink("readme.md", path.join(sandbox, "link"));
    await fs.writeFile(path.join(sandbox, "run.sh"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    await fs.writeFile(
      path.join(sandbox, "data.bin"),
      Buffer.from([0, 255, 1, 254, 0]),
    );
    const index = path.join(dir, "snapshot-index");
    await execute("git", ["-C", sandbox, "add", "-A"], {
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
    const tree = (
      await execute("git", ["-C", sandbox, "write-tree"], {
        env: { ...process.env, GIT_INDEX_FILE: index },
      })
    ).stdout.trim();

    const { pack, shallow } = await buildSeedPack({
      repoPath: sandbox,
      head,
      base,
      tree,
    });
    expect(shallow).toEqual([base]);
    const restored = path.join(dir, "restored");
    await fs.mkdir(restored);
    await git(restored, ["init", "-q", "-b", "main"]);
    await fs.writeFile(
      path.join(dir, "seed.b64"),
      Buffer.from(pack).toString("base64"),
    );
    await execute(
      "bash",
      [
        "-c",
        [
          seedPackInstallScript({ packFile: "../seed.b64", shallow }),
          `git checkout -q -f -B feature/x ${head}`,
          `git diff-tree -r --no-renames --name-only -z ${head} ${tree} | GIT_LITERAL_PATHSPECS=1 git restore --source=${tree} --worktree --pathspec-from-file=- --pathspec-file-nul`,
        ].join(" && "),
      ],
      { cwd: restored },
    );
    expect(await git(restored, ["branch", "--show-current"])).toBe("feature/x");
    expect(await git(restored, ["log", "--format=%s"])).toBe(
      "Agent commit\nBase",
    );
    expect(
      (await nativeGit(restored, ["status", "--porcelain"]))
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual(
      [
        " M readme.md",
        " D src/app.ts",
        "?? data.bin",
        "?? link",
        "?? run.sh",
        "?? untracked.txt",
      ].sort(),
    );
    expect(await fs.readlink(path.join(restored, "link"))).toBe("readme.md");
    expect((await fs.stat(path.join(restored, "run.sh"))).mode & 0o111).toBe(
      0o111,
    );
    expect(await fs.readFile(path.join(restored, "data.bin"))).toEqual(
      Buffer.from([0, 255, 1, 254, 0]),
    );
    // History ends at the base: its parents were never sent.
    expect(await git(restored, ["rev-list", "--count", "HEAD"])).toBe("2");
  });
});

describe("a session's checkpoints (ADR 0342)", () => {
  let dir: string;
  let manager: ProjectManager;
  let base: string;
  const args = { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION };

  const git = (cwd: string, gitArgs: readonly string[]) =>
    nativeGit(cwd, gitArgs).then((output) => output.trim());

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-checkpoint-"));
    manager = new ProjectManager(
      new FsBackend(path.join(dir, "a")),
      new ObjectRemoteBackend({ store: new InMemoryObjectStore() }),
    );
    const main = await manager.create(TENANT, PROJECT, {
      initialFiles: { "notes.md": "original\n" },
    });
    base = await main.resolveRef("HEAD");
    await main.dispose();
    await manager.setSessionBase({ ...args, commit: base });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts at the base, on the session's own branch", async () => {
    const work = await manager.sessionWork({ ...args, base });
    expect(work).toMatchObject({ head: base, branch: "work/0a1b2c3d" });
    expect(work.checkpoint).not.toBe(base);
    // Nothing changed: no additional checkpoint is written.
    expect(
      await manager.checkpointSession({
        ...args,
        base,
        message: "Turn",
        author: AUTHOR,
      }),
    ).toBe(work.checkpoint);
  });

  it("does not read checkpoint fields from the repository's base message", async () => {
    const origin = manager.remoteBackend;
    if (!origin) throw new Error("The fixture needs an origin");
    const main = await manager.open(TENANT, PROJECT);
    try {
      const message = checkpointMessage({
        message: "Document checkpoint fields",
        work: {
          head: base,
          branch: "work/example",
          pushed: { branch: "work/example", commit: base },
        },
      });
      await git(main.repoPath, [
        ...agent,
        "commit",
        "--allow-empty",
        "-m",
        message,
      ]);
      const documented = await main.resolveRef("HEAD");
      await push({
        dev: main,
        remote: origin,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      await manager.setSessionBase({ ...args, commit: documented });

      const initialized = await manager.sessionWork({
        ...args,
        base: documented,
      });
      expect(initialized.checkpoint).not.toBe(documented);
      expect(initialized).toEqual({
        checkpoint: initialized.checkpoint,
        head: documented,
        branch: "work/0a1b2c3d",
      });

      await manager.resetSession({ ...args, commit: documented });
      expect(await manager.sessionWork({ ...args, base: documented })).toEqual({
        checkpoint: documented,
        head: documented,
        branch: "work/0a1b2c3d",
      });
    } finally {
      await main.dispose();
    }
  });

  it("keeps the agent's commits and branch beside the saved files", async () => {
    const copy = await manager.openSession(args);
    // The agent committed one file and left another uncommitted.
    const tree = await git(copy.repoPath, ["rev-parse", `${base}^{tree}`]);
    const head = await git(copy.repoPath, [
      ...agent,
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "Agent commit",
    ]);
    await copy.writeFile("draft.md", "uncommitted\n");
    await copy.dispose();
    const first = await manager.checkpointSession({
      ...args,
      base,
      message: "First turn",
      author: AUTHOR,
      work: { head, branch: "feature/x" },
    });
    expect(first).not.toBe(base);
    expect(await manager.sessionWork({ ...args, base })).toEqual({
      checkpoint: first,
      head,
      branch: "feature/x",
    });

    // The branch alone moving is a checkpoint too, with the same files.
    const renamed = await manager.checkpointSession({
      ...args,
      base,
      message: "Second turn",
      author: AUTHOR,
      work: { head, branch: "feature/y" },
    });
    expect(renamed).not.toBe(first);
    const after = await manager.openSession(args);
    expect(await after.readFile("draft.md")).toBe("uncommitted\n");
    expect((await after.status()).dirty).toBe(false);
    expect(
      await git(after.repoPath, ["log", "-1", "--format=%P", renamed]),
    ).toBe(`${first} ${head}`);
    expect(await git(after.repoPath, ["rev-parse", `${renamed}^{tree}`])).toBe(
      await git(after.repoPath, ["rev-parse", `${first}^{tree}`]),
    );
    await after.dispose();

    // The pushed branch travels with the checkpoints that follow.
    const pushed = { branch: "work/feature-y-0a1b2c3d", commit: head };
    await manager.checkpointSession({
      ...args,
      base,
      message: "Open a pull request",
      author: AUTHOR,
      pushed,
    });
    const next = await manager.openSession(args);
    await next.writeFile("draft.md", "more\n");
    await next.dispose();
    await manager.checkpointSession({
      ...args,
      base,
      message: "Third turn",
      author: AUTHOR,
    });
    expect(await manager.sessionWork({ ...args, base })).toMatchObject({
      head,
      branch: "feature/y",
      pushed,
    });
  });

  it("carries commits, branch and files to another machine through one ref", async () => {
    const copy = await manager.openSession(args);
    const tree = await git(copy.repoPath, ["rev-parse", `${base}^{tree}`]);
    const head = await git(copy.repoPath, [
      ...agent,
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "Agent commit",
    ]);
    await copy.writeFile("draft.md", "uncommitted\n");
    await copy.dispose();
    const checkpoint = await manager.checkpointSession({
      ...args,
      base,
      message: "Turn",
      author: AUTHOR,
      work: { head, branch: "feature/x" },
    });

    const other = new ProjectManager(
      new FsBackend(path.join(dir, "b")),
      manager.remoteBackend,
    );
    expect(await other.sessionWork({ ...args, base })).toEqual({
      checkpoint,
      head,
      branch: "feature/x",
    });
    const there = await other.openSession(args);
    expect(await there.readFile("draft.md")).toBe("uncommitted\n");
    expect(await git(there.repoPath, ["log", "-1", "--format=%s", head])).toBe(
      "Agent commit",
    );
    await there.dispose();

    // A rollback to the base forgets the branch with the files.
    await other.resetSession({ ...args, commit: base });
    expect(await other.sessionWork({ ...args, base })).toEqual({
      checkpoint: base,
      head: base,
      branch: "work/0a1b2c3d",
    });
  });

  it("refuses a checkpoint whose agent commit is not in the copy", async () => {
    const initial = await manager.sessionWork({ ...args, base });
    await expect(
      manager.checkpointSession({
        ...args,
        base,
        message: "Turn",
        author: AUTHOR,
        work: { head: "c".repeat(40), branch: "feature/x" },
      }),
    ).rejects.toThrow();
    expect(await manager.sessionWork({ ...args, base })).toEqual(initial);
  });

  it("gives a session that only has saved files a base, with them uncommitted on top", async () => {
    const legacy = {
      ...args,
      sessionId: "1b2c3d4e-0000-4000-8000-000000000001",
    };
    const copy = await manager.openSession(legacy);
    await copy.writeFile("notes.md", "edited before\n");
    await copy.commit("Old checkpoint", AUTHOR);
    await copy.dispose();
    await manager.adoptSessionBase({
      ...legacy,
      commit: base,
      message: "Stand on a base",
      author: AUTHOR,
    });
    const work = await manager.sessionWork({ ...legacy, base });
    expect(work).toMatchObject({ head: base, branch: "work/1b2c3d4e" });
    const after = await manager.openSession(legacy);
    expect(await after.readFile("notes.md")).toBe("edited before\n");
    expect((await after.status()).dirty).toBe(false);
    await after.dispose();
  });
});
