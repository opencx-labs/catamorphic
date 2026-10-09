import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseWorktreePorcelain,
  SessionCheckouts,
} from "./session-checkouts.js";

const execFileAsync = promisify(execFile);
const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const secondSessionId = "22222222-3333-4333-8333-333333333333";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout;
}

describe("SessionCheckouts", () => {
  let tmpDir: string;
  let rootPath: string;
  let pglite: PGlite;
  let checkouts: SessionCheckouts;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-checkouts-"));
    rootPath = path.join(tmpDir, "project");
    await fs.mkdir(rootPath);
    await git(rootPath, ["init", "-b", "main"]);
    await fs.writeFile(path.join(rootPath, "README.md"), "hello\n");
    await git(rootPath, ["add", "README.md"]);
    await git(rootPath, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial",
    ]);
    pglite = new PGlite();
    checkouts = new SessionCheckouts({
      pglite,
      worktreesDirectory: path.join(tmpDir, "worktrees"),
      projectRoot: (id) => (id === projectId ? rootPath : undefined),
    });
    await checkouts.init();
  }, 60_000);

  afterEach(async () => {
    await pglite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists no worktrees for an unversioned project without creating Git", async () => {
    await fs.rm(path.join(rootPath, ".git"), { recursive: true });
    expect(await checkouts.list(projectId)).toEqual([]);
    expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
      kind: "primary",
      path: rootPath,
    });
    expect(await fs.readdir(rootPath)).not.toContain(".git");
  });

  it.each(["primary", "worktree"])(
    "keeps private workflow files out of %s checkpoints",
    async (kind) => {
      const workingDirectory =
        kind === "primary"
          ? rootPath
          : (await checkouts.createManaged({ projectId, sessionId })).path;
      const personal = ".work/personal/profile-one/workflows/check.ts";
      await fs.mkdir(path.dirname(path.join(workingDirectory, personal)), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workingDirectory, personal),
        "private workflow",
      );
      await fs.writeFile(
        path.join(workingDirectory, "shared.txt"),
        "shared work",
      );
      const checkpoint = {
        projectId,
        sessionId,
        workingDirectory,
        message: "Save work",
      };
      expect(await checkouts.checkpoint(checkpoint)).not.toBeNull();
      expect(
        await git(workingDirectory, ["ls-tree", "-r", "--name-only", "HEAD"]),
      ).toContain("shared.txt");
      expect(
        await git(workingDirectory, ["ls-tree", "-r", "--name-only", "HEAD"]),
      ).not.toContain(personal);
      expect(await git(workingDirectory, ["status", "--porcelain"])).toBe("");
      expect(await checkouts.checkpoint(checkpoint)).toBeNull();
      await git(workingDirectory, ["add", "-f", "--", personal]);
      await expect(checkouts.checkpoint(checkpoint)).rejects.toThrow(
        "Personal files are tracked",
      );
    },
  );

  it("starts a worktree at a commit held by the host's mirror (ADR 0178)", async () => {
    // A mirror holding a pull request head the project's checkout lacks.
    const mirror = path.join(tmpDir, "mirror.git");
    await execFileAsync("git", ["clone", "-q", "--bare", rootPath, mirror]);
    const work = path.join(tmpDir, "pr-work");
    await execFileAsync("git", ["clone", "-q", mirror, work]);
    await fs.writeFile(path.join(work, "README.md"), "pull request\n");
    await git(work, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qam",
      "Change",
    ]);
    const head = (await git(work, ["rev-parse", "HEAD"])).trim();
    await git(work, ["push", "-q", mirror, `HEAD:refs/work/base/${sessionId}`]);

    const created = await checkouts.createManaged({
      projectId,
      sessionId,
      start: {
        repository: mirror,
        ref: `refs/work/base/${sessionId}`,
        commit: head,
      },
    });
    expect((await git(created.path, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(
      await fs.readFile(path.join(created.path, "README.md"), "utf8"),
    ).toBe("pull request\n");
    expect(created.branch).toMatch(/^work\/22222222/);
  });

  it("moves a chat asked for a new base out of the project folder, never touching it (ADR 0178)", async () => {
    const mirror = path.join(tmpDir, "move-mirror.git");
    await execFileAsync("git", ["clone", "-q", "--bare", rootPath, mirror]);
    const work = path.join(tmpDir, "move-work");
    await execFileAsync("git", ["clone", "-q", mirror, work]);
    await fs.writeFile(path.join(work, "README.md"), "new base\n");
    await git(work, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qam",
      "Base",
    ]);
    const head = (await git(work, ["rev-parse", "HEAD"])).trim();
    await git(work, ["push", "-q", mirror, `HEAD:refs/work/move/${sessionId}`]);
    // The person's own work in the project folder.
    const before = (await git(rootPath, ["rev-parse", "HEAD"])).trim();
    await fs.writeFile(path.join(rootPath, "README.md"), "my edit\n");
    await fs.writeFile(path.join(rootPath, "draft.md"), "untracked\n");
    const requiresIsolation = async () => false;

    // Without a base, the chat works in the project folder, which is not its own.
    expect(
      await checkouts.resolveForAgent({
        projectId,
        sessionId,
        requiresIsolation,
      }),
    ).toEqual({ path: rootPath, owned: false });
    // A pending move gives it its own worktree at the new base.
    const moved = await checkouts.resolveForAgent({
      projectId,
      sessionId,
      workspace: {
        repository: mirror,
        pin: `refs/work/move/${sessionId}`,
        commit: head,
      },
      requiresIsolation,
    });
    expect(moved.owned).toBe(true);
    expect(moved.path).not.toBe(rootPath);
    expect((await git(moved.path, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect((await git(rootPath, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect(await fs.readFile(path.join(rootPath, "README.md"), "utf8")).toBe(
      "my edit\n",
    );
    expect(await fs.readFile(path.join(rootPath, "draft.md"), "utf8")).toBe(
      "untracked\n",
    );
    // Later turns stay in the chat's own worktree.
    expect(
      await checkouts.resolveForAgent({
        projectId,
        sessionId,
        requiresIsolation,
      }),
    ).toEqual({ path: moved.path, owned: true });
  });

  it("never reports an assigned worktree as the chat's own", async () => {
    const external = path.join(tmpDir, "assigned");
    await git(rootPath, ["worktree", "add", "-q", "-b", "assigned", external]);
    await checkouts.adopt({ projectId, sessionId, path: external });
    const resolved = await checkouts.resolveForAgent({
      projectId,
      sessionId,
      workspace: { repository: rootPath, pin: "refs/heads/main", commit: "0" },
      requiresIsolation: async () => false,
    });
    expect(resolved.owned).toBe(false);
    expect(resolved.path).toBe(await fs.realpath(external));
  });

  it("keeps a new session on primary until it creates a worktree", async () => {
    expect(await checkouts.resolve({ projectId, sessionId })).toBe(rootPath);

    const created = await checkouts.createManaged({ projectId, sessionId });
    expect(created.kind).toBe("managed");
    expect(created.branch).toMatch(/^work\/22222222/);
    expect(await checkouts.resolve({ projectId, sessionId })).toBe(
      created.path,
    );
    expect(await checkouts.list(projectId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: await fs.realpath(rootPath),
          kind: "primary",
        }),
        expect.objectContaining({ path: created.path, kind: "managed" }),
      ]),
    );
    expect(await checkouts.assigned(projectId)).toEqual([
      {
        sessionId,
        kind: "managed",
        path: created.path,
        branch: created.branch,
        present: true,
      },
    ]);

    await checkouts.returnPrimary({ projectId, sessionId });
    expect(await checkouts.resolve({ projectId, sessionId })).toBe(rootPath);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
  });

  it("uses a stable numeric suffix when managed branch names collide", async () => {
    const first = await checkouts.createManaged({ projectId, sessionId });
    const second = await checkouts.createManaged({
      projectId,
      sessionId: secondSessionId,
    });

    expect(first.branch).toBe("work/22222222");
    expect(second.branch).toBe("work/22222222-1");
  });

  it("returns one managed checkout for parallel creation in the same session", async () => {
    const [first, second] = await Promise.all([
      checkouts.createManaged({ projectId, sessionId }),
      checkouts.createManaged({ projectId, sessionId }),
    ]);

    expect(second).toEqual(first);
    expect(await checkouts.list(projectId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: first.path, kind: "managed" }),
      ]),
    );
    expect(
      (await checkouts.list(projectId)).filter(
        (worktree) => worktree.kind === "managed",
      ),
    ).toHaveLength(1);
  });

  it("cleans up a managed worktree rejected by the locked policy check", async () => {
    const managedPath = path.join(tmpDir, "worktrees", projectId, sessionId);
    await expect(
      checkouts.createManaged({
        projectId,
        sessionId,
        ensureAvailable: async () => {
          throw new Error("occupied");
        },
      }),
    ).rejects.toThrow("occupied");

    await expect(fs.access(managedPath)).rejects.toThrow();
    await expect(
      git(rootPath, ["show-ref", "--verify", "refs/heads/work/22222222"]),
    ).rejects.toThrow();
    expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
      kind: "primary",
    });
  });

  it("detects a running peer assigned to the same checkout", async () => {
    const created = await checkouts.createManaged({ projectId, sessionId });
    await checkouts.adopt({
      projectId,
      sessionId: secondSessionId,
      path: created.path,
    });

    await expect(
      checkouts.isOccupied({
        projectId,
        sessionId,
        path: created.path,
        peerSessionIds: [secondSessionId],
      }),
    ).resolves.toBe(true);
    await expect(
      checkouts.isOccupied({
        projectId,
        sessionId,
        path: rootPath,
        peerSessionIds: [secondSessionId],
      }),
    ).resolves.toBe(false);
  });

  it("atomically assigns only one isolated session to an external worktree", async () => {
    const external = path.join(tmpDir, "contended-external");
    await git(rootPath, ["worktree", "add", "-b", "contended", external]);

    const results = await Promise.allSettled([
      checkouts.withAssignmentLock({
        projectId,
        operation: async () => {
          if (
            await checkouts.isOccupied({
              projectId,
              sessionId,
              path: external,
              peerSessionIds: [secondSessionId],
            })
          ) {
            throw new Error("occupied");
          }
          return checkouts.adopt({ projectId, sessionId, path: external });
        },
      }),
      checkouts.withAssignmentLock({
        projectId,
        operation: async () => {
          if (
            await checkouts.isOccupied({
              projectId,
              sessionId: secondSessionId,
              path: external,
              peerSessionIds: [sessionId],
            })
          ) {
            throw new Error("occupied");
          }
          return checkouts.adopt({
            projectId,
            sessionId: secondSessionId,
            path: external,
          });
        },
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("atomically returns only one isolated session to the primary checkout", async () => {
    const first = await checkouts.createManaged({ projectId, sessionId });
    const second = await checkouts.createManaged({
      projectId,
      sessionId: secondSessionId,
    });
    expect(first.path).not.toBe(second.path);

    const results = await Promise.allSettled([
      checkouts.withAssignmentLock({
        projectId,
        operation: async () => {
          if (
            await checkouts.isOccupied({
              projectId,
              sessionId,
              path: rootPath,
              peerSessionIds: [secondSessionId],
            })
          ) {
            throw new Error("occupied");
          }
          return checkouts.returnPrimary({ projectId, sessionId });
        },
      }),
      checkouts.withAssignmentLock({
        projectId,
        operation: async () => {
          if (
            await checkouts.isOccupied({
              projectId,
              sessionId: secondSessionId,
              path: rootPath,
              peerSessionIds: [sessionId],
            })
          ) {
            throw new Error("occupied");
          }
          return checkouts.returnPrimary({
            projectId,
            sessionId: secondSessionId,
          });
        },
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("adopts only external worktrees from the same repository", async () => {
    const external = path.join(tmpDir, "external");
    await git(rootPath, ["worktree", "add", "-b", "external", external]);
    const adopted = await checkouts.adopt({
      projectId,
      sessionId,
      path: external,
    });
    expect(adopted).toMatchObject({
      kind: "external",
      path: await fs.realpath(external),
    });
    expect(await checkouts.list(projectId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: await fs.realpath(external),
          kind: "external",
        }),
      ]),
    );

    const other = path.join(tmpDir, "other");
    await fs.mkdir(other);
    await git(other, ["init"]);
    await expect(
      checkouts.adopt({ projectId, sessionId, path: other }),
    ).rejects.toThrow(/same Git repository/);
  });

  it("rejects a dirty external worktree without changing the binding", async () => {
    const external = path.join(tmpDir, "dirty-external");
    await git(rootPath, ["worktree", "add", "-b", "dirty", external]);
    await fs.writeFile(path.join(external, "draft.txt"), "uncommitted\n");

    await expect(
      checkouts.adopt({ projectId, sessionId, path: external }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
      kind: "primary",
    });
  });

  it("requires an explicit commit before naming a detached external worktree for review", async () => {
    const external = path.join(tmpDir, "detached-external");
    await git(rootPath, ["worktree", "add", "--detach", external]);
    await checkouts.adopt({ projectId, sessionId, path: external });
    await fs.writeFile(path.join(external, "review.txt"), "ready\n");

    await expect(
      checkouts.preparePullRequest({
        projectId,
        sessionId,
        message: "Prepare review",
      }),
    ).rejects.toThrow("Record your changes");
    expect((await git(external, ["status", "--porcelain"])).trim()).toBe(
      "?? review.txt",
    );
    await git(external, ["add", "review.txt"]);
    await git(external, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Explicit review",
    ]);
    const prepared = await checkouts.preparePullRequest({
      projectId,
      sessionId,
      message: "Prepare review",
    });

    expect(prepared.branch).toBe("work/22222222-review");
    expect((await git(external, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(external, ["branch", "--show-current"])).trim()).toBe(
      prepared.branch,
    );
  });

  it("requires explicit recovery when an assigned worktree disappears", async () => {
    const external = path.join(tmpDir, "assigned");
    await git(rootPath, ["worktree", "add", "-q", "-b", "assigned", external]);
    await checkouts.adopt({ projectId, sessionId, path: external });
    await fs.rm(external, { recursive: true, force: true });
    await expect(checkouts.resolve({ projectId, sessionId })).rejects.toThrow(
      "The assigned worktree",
    );
    await expect(
      checkouts.resolveForAgent({
        projectId,
        sessionId,
        requiresIsolation: async () => false,
      }),
    ).rejects.toThrow("The assigned worktree");
    await checkouts.returnPrimary({ projectId, sessionId });
    expect(await checkouts.resolve({ projectId, sessionId })).toBe(rootPath);
    expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
      kind: "primary",
    });
  });

  it("serializes checkpoints across worktrees of the same repository", async () => {
    const first = await checkouts.createManaged({ projectId, sessionId });
    const second = await checkouts.createManaged({
      projectId,
      sessionId: secondSessionId,
    });
    await Promise.all([
      fs.writeFile(path.join(first.path, "one.txt"), "one\n"),
      fs.writeFile(path.join(second.path, "two.txt"), "two\n"),
    ]);

    const commits = await Promise.all([
      checkouts.checkpoint({
        projectId,
        sessionId,
        workingDirectory: first.path,
        message: "First checkpoint",
      }),
      checkouts.checkpoint({
        projectId,
        sessionId: secondSessionId,
        workingDirectory: second.path,
        message: "Second checkpoint",
      }),
    ]);

    expect(commits).toEqual([
      expect.stringMatching(/^[0-9a-f]{40,64}$/),
      expect.stringMatching(/^[0-9a-f]{40,64}$/),
    ]);
  });

  it("rolls a chat's own worktree back to a turn's start, keeping history (ADR 0197)", async () => {
    const owned = await checkouts.createManaged({ projectId, sessionId });
    const before = await checkouts.head({ workingDirectory: owned.path });
    await fs.writeFile(path.join(owned.path, "README.md"), "changed\n");
    await fs.writeFile(path.join(owned.path, "added.txt"), "added\n");
    const after = await checkouts.checkpoint({
      projectId,
      sessionId,
      workingDirectory: owned.path,
      message: "Turn",
    });
    // A later turn's unrecorded leftovers go too.
    await fs.writeFile(path.join(owned.path, "scratch.txt"), "scratch\n");
    expect(
      await checkouts.restore({
        projectId,
        workingDirectory: owned.path,
        commit: before ?? "",
        expectedHead: after,
        owned: true,
      }),
    ).toBe("restored");
    expect(await fs.readFile(path.join(owned.path, "README.md"), "utf8")).toBe(
      "hello\n",
    );
    const files = await fs.readdir(owned.path);
    expect(files).not.toContain("added.txt");
    expect(files).not.toContain("scratch.txt");
    // The branch still holds the turn's checkpoint.
    expect(await checkouts.head({ workingDirectory: owned.path })).toBe(after);
  });

  it("rolls the person's own folder back only while nothing else changed it", async () => {
    const before = await checkouts.head({ workingDirectory: rootPath });
    await fs.writeFile(path.join(rootPath, "notes.md"), "turn\n");
    const after = await checkouts.checkpoint({
      projectId,
      sessionId,
      workingDirectory: rootPath,
      message: "Turn",
    });
    const restore = {
      projectId,
      workingDirectory: rootPath,
      commit: before ?? "",
      expectedHead: after,
      owned: false,
    };
    await fs.writeFile(path.join(rootPath, "mine.md"), "the person's\n");
    expect(await checkouts.restore(restore)).toContain("not recorded yet");
    expect(await fs.readFile(path.join(rootPath, "notes.md"), "utf8")).toBe(
      "turn\n",
    );
    await fs.rm(path.join(rootPath, "mine.md"));
    expect(
      await checkouts.restore({ ...restore, expectedHead: before }),
    ).toContain("changed since the chat's last turn");
    expect(await checkouts.restore(restore)).toBe("restored");
    expect(await fs.readdir(rootPath)).not.toContain("notes.md");
  });

  describe("a chat's own worktree (ADR 0215)", () => {
    const agentCheckout = () =>
      checkouts.resolveForAgent({
        projectId,
        sessionId,
        requiresIsolation: async () => false,
      });
    const commit = (cwd: string, message: string) =>
      git(cwd, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qam",
        message,
      ]);

    it("is chosen first and checked out by the chat's next turn, named after the project", async () => {
      const planned = await checkouts.plan({ projectId, sessionId });
      expect(planned).toMatchObject({
        kind: "managed",
        branch: null,
        present: false,
      });
      await expect(fs.access(planned.path)).rejects.toThrow();
      expect(path.basename(planned.path)).toBe("project");
      expect(await checkouts.detail({ projectId, sessionId })).toMatchObject({
        kind: "managed",
        changedFiles: 0,
        present: false,
      });

      const checkout = await agentCheckout();
      expect(checkout.owned).toBe(true);
      expect(checkout.path).toBe(await fs.realpath(planned.path));
      expect(
        (await git(checkout.path, ["branch", "--show-current"])).trim(),
      ).toBe("work/22222222");
      expect((await git(checkout.path, ["rev-parse", "HEAD"])).trim()).toBe(
        (await git(rootPath, ["rev-parse", "HEAD"])).trim(),
      );
    });

    it("copies only the ignored files .worktreeinclude lists, never a symlink", async () => {
      await fs.writeFile(
        path.join(rootPath, ".gitignore"),
        ".env\n.env.local\nnode_modules/\nlinked.env\n",
      );
      await fs.writeFile(
        path.join(rootPath, ".worktreeinclude"),
        "*.env\n.env*\n",
      );
      await git(rootPath, ["add", ".gitignore", ".worktreeinclude"]);
      await commit(rootPath, "Ignore");
      await fs.writeFile(path.join(rootPath, ".env"), "SECRET=1\n");
      await fs.writeFile(path.join(rootPath, ".env.local"), "LOCAL=1\n");
      await fs.writeFile(path.join(rootPath, "untracked.env"), "not ignored\n");
      await fs.mkdir(path.join(rootPath, "node_modules"));
      await fs.writeFile(path.join(rootPath, "node_modules", "big.js"), "x");
      await fs.symlink(
        path.join(rootPath, ".env"),
        path.join(rootPath, "linked.env"),
      );

      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      expect(await fs.readFile(path.join(worktree, ".env"), "utf8")).toBe(
        "SECRET=1\n",
      );
      expect(await fs.readFile(path.join(worktree, ".env.local"), "utf8")).toBe(
        "LOCAL=1\n",
      );
      await expect(
        fs.access(path.join(worktree, "untracked.env")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(worktree, "node_modules")),
      ).rejects.toThrow();
      await expect(
        fs.lstat(path.join(worktree, "linked.env")),
      ).rejects.toThrow();
    });

    it("is put away with its work recorded and checked out again from its branch", async () => {
      await checkouts.plan({ projectId, sessionId });
      const first = await agentCheckout();
      await fs.writeFile(path.join(first.path, "draft.md"), "unrecorded\n");

      await checkouts.putAway({ projectId, sessionId });
      await expect(fs.access(first.path)).rejects.toThrow();
      expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
        kind: "managed",
        branch: "work/22222222",
        present: false,
      });
      expect(await git(rootPath, ["show", "work/22222222:draft.md"])).toBe(
        "unrecorded\n",
      );
      expect(await checkouts.detail({ projectId, sessionId })).toMatchObject({
        changedFiles: 1,
      });

      const again = await agentCheckout();
      expect(again.path).toBe(first.path);
      expect(await fs.readFile(path.join(again.path, "draft.md"), "utf8")).toBe(
        "unrecorded\n",
      );
    });

    it("stays when it holds personal files Git cannot record", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      const personal = path.join(worktree, ".work", "personal", "notes.md");
      await fs.mkdir(path.dirname(personal), { recursive: true });
      await fs.writeFile(personal, "mine\n");
      await checkouts.putAway({ projectId, sessionId });
      expect(await fs.readFile(personal, "utf8")).toBe("mine\n");
    });

    it("brings its changes into the project folder, uncommitted, and goes", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      await fs.writeFile(path.join(worktree, "README.md"), "hello world\n");
      await fs.writeFile(path.join(worktree, "new.txt"), "new\n");
      await checkouts.checkpoint({
        projectId,
        sessionId,
        workingDirectory: worktree,
        message: "Turn",
      });
      await fs.writeFile(path.join(worktree, "later.txt"), "after the turn\n");
      // The folder moved on meanwhile, elsewhere.
      await fs.writeFile(path.join(rootPath, "other.txt"), "other\n");
      await git(rootPath, ["add", "other.txt"]);
      await commit(rootPath, "Elsewhere");
      const head = (await git(rootPath, ["rev-parse", "HEAD"])).trim();
      expect(await checkouts.detail({ projectId, sessionId })).toMatchObject({
        changedFiles: 3,
      });

      const brought = await checkouts.bringToProjectFolder({
        projectId,
        sessionId,
      });
      expect([...brought.files].sort()).toEqual([
        "README.md",
        "later.txt",
        "new.txt",
      ]);
      expect(await fs.readFile(path.join(rootPath, "README.md"), "utf8")).toBe(
        "hello world\n",
      );
      expect(await fs.readFile(path.join(rootPath, "later.txt"), "utf8")).toBe(
        "after the turn\n",
      );
      expect((await git(rootPath, ["rev-parse", "HEAD"])).trim()).toBe(head);
      expect(await git(rootPath, ["diff", "--cached", "--name-only"])).toBe("");
      await expect(fs.access(worktree)).rejects.toThrow();
      await expect(
        git(rootPath, ["show-ref", "--verify", "refs/heads/work/22222222"]),
      ).rejects.toThrow();
      expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
        kind: "primary",
      });
      const notice = await checkouts.notice({ projectId, sessionId });
      expect(notice).toContain("brought this chat's changes");
      expect(await checkouts.notice({ projectId, sessionId })).toBeNull();
    });

    it("changes nothing when the project folder's own changes touch the same files", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      await fs.writeFile(path.join(worktree, "README.md"), "from the chat\n");
      await fs.writeFile(path.join(rootPath, "README.md"), "from the person\n");

      await expect(
        checkouts.bringToProjectFolder({ projectId, sessionId }),
      ).rejects.toThrow("uncommitted changes to README.md");
      expect(await fs.readFile(path.join(rootPath, "README.md"), "utf8")).toBe(
        "from the person\n",
      );
      expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
        kind: "managed",
        present: true,
      });
    });

    it("changes nothing when its changes conflict with the folder's newer commits", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      await fs.writeFile(path.join(worktree, "README.md"), "from the chat\n");
      await fs.writeFile(path.join(rootPath, "README.md"), "committed\n");
      await commit(rootPath, "Person");

      await expect(
        checkouts.bringToProjectFolder({ projectId, sessionId }),
      ).rejects.toThrow("conflict with the project folder's latest commits");
      expect(await git(rootPath, ["status", "--porcelain"])).toBe("");
      expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
        kind: "managed",
      });
    });

    it("is discarded with its branch, and the chat works in the folder again", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      await fs.writeFile(path.join(worktree, "scratch.txt"), "drop me\n");
      await checkouts.discard({ projectId, sessionId });
      await expect(fs.access(worktree)).rejects.toThrow();
      await expect(
        git(rootPath, ["show-ref", "--verify", "refs/heads/work/22222222"]),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(rootPath, "scratch.txt")),
      ).rejects.toThrow();
      expect((await agentCheckout()).path).toBe(rootPath);
      expect(await checkouts.notice({ projectId, sessionId })).toContain(
        "discarded",
      );
    });

    it("brings bytes exactly, whatever the person's diff settings", async () => {
      await git(rootPath, ["config", "diff.noprefix", "true"]);
      await fs.writeFile(
        path.join(rootPath, ".gitattributes"),
        "*.bin diff=hex\n",
      );
      await git(rootPath, ["config", "diff.hex.textconv", "od -c"]);
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
      const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10]);
      await fs.mkdir(path.join(worktree, "src"));
      await fs.writeFile(path.join(worktree, "src", "menu.txt"), latin1);
      await fs.writeFile(path.join(worktree, "src", "blob.bin"), binary);
      await checkouts.bringToProjectFolder({ projectId, sessionId });
      expect(await fs.readFile(path.join(rootPath, "src", "menu.txt"))).toEqual(
        latin1,
      );
      expect(await fs.readFile(path.join(rootPath, "src", "blob.bin"))).toEqual(
        binary,
      );
    });

    it("keeps a worktree Git is mid-operation in, and will not bring it", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      await fs.writeFile(path.join(worktree, "notes.md"), "a\n");
      await checkouts.checkpoint({
        projectId,
        sessionId,
        workingDirectory: worktree,
        message: "Turn",
      });
      await git(worktree, ["checkout", "-q", "--detach"]);
      await fs.writeFile(path.join(worktree, "detached.md"), "b\n");
      await checkouts.putAway({ projectId, sessionId });
      expect(
        await fs.readFile(path.join(worktree, "detached.md"), "utf8"),
      ).toBe("b\n");
      await expect(
        checkouts.bringToProjectFolder({ projectId, sessionId }),
      ).rejects.toThrow("not on a branch");
      await expect(
        fs.access(path.join(rootPath, "notes.md")),
      ).rejects.toThrow();
    });

    it("follows the branch the chat switched its worktree to", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      await git(worktree, ["switch", "-q", "-c", "feature"]);
      await fs.writeFile(path.join(worktree, "feature.md"), "f\n");
      await checkouts.putAway({ projectId, sessionId });
      expect(await git(rootPath, ["show", "feature:feature.md"])).toBe("f\n");
      expect(await checkouts.describe({ projectId, sessionId })).toMatchObject({
        branch: "feature",
        present: false,
      });
      const again = await agentCheckout();
      expect(
        await fs.readFile(path.join(again.path, "feature.md"), "utf8"),
      ).toBe("f\n");
    });

    it("never removes a worktree another chat uses", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      const other = await checkouts.adopt({
        projectId,
        sessionId: secondSessionId,
        path: worktree,
      });
      expect(other.kind).toBe("external");
      await checkouts.putAway({ projectId, sessionId });
      await expect(fs.access(worktree)).resolves.toBeUndefined();
      await expect(checkouts.discard({ projectId, sessionId })).rejects.toThrow(
        "Another chat works in this worktree",
      );
      await expect(fs.access(worktree)).resolves.toBeUndefined();
    });

    it("will not bring a worktree holding personal files", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      const personal = path.join(worktree, ".work", "personal", "notes.md");
      await fs.mkdir(path.dirname(personal), { recursive: true });
      await fs.writeFile(personal, "mine\n");
      await expect(
        checkouts.bringToProjectFolder({ projectId, sessionId }),
      ).rejects.toThrow("personal files");
      expect(await fs.readFile(personal, "utf8")).toBe("mine\n");
    });

    it("leaves the folder alone while a turn runs in the chat", async () => {
      let running = true;
      const guarded = new SessionCheckouts({
        pglite,
        worktreesDirectory: path.join(tmpDir, "worktrees"),
        projectRoot: (id) => (id === projectId ? rootPath : undefined),
        sessionRunning: async () => running,
      });
      await guarded.plan({ projectId, sessionId });
      const { path: worktree } = await guarded.resolveForAgent({
        projectId,
        sessionId,
        requiresIsolation: async () => false,
      });
      await guarded.putAway({ projectId, sessionId });
      await expect(fs.access(worktree)).resolves.toBeUndefined();
      await expect(
        guarded.bringToProjectFolder({ projectId, sessionId }),
      ).rejects.toThrow("after the current turn finishes");
      await expect(guarded.discard({ projectId, sessionId })).rejects.toThrow(
        "after the current turn finishes",
      );
      running = false;
      await guarded.putAway({ projectId, sessionId });
      await expect(fs.access(worktree)).rejects.toThrow();
    });

    it("reports an assigned folder that is gone instead of failing", async () => {
      const external = path.join(tmpDir, "assigned");
      await git(rootPath, [
        "worktree",
        "add",
        "-q",
        "-b",
        "assigned",
        external,
      ]);
      await checkouts.adopt({ projectId, sessionId, path: external });
      await fs.rm(external, { recursive: true, force: true });
      expect(await checkouts.detail({ projectId, sessionId })).toMatchObject({
        kind: "external",
        available: false,
        present: false,
      });
    });

    it("puts away resting chats' worktrees and worktrees agents left when the host starts", async () => {
      await checkouts.plan({ projectId, sessionId });
      const resting = await agentCheckout();
      await fs.writeFile(path.join(resting.path, "kept.md"), "k\n");
      const left = await checkouts.createManaged({
        projectId,
        sessionId: secondSessionId,
      });
      await fs.writeFile(path.join(left.path, "left.md"), "l\n");
      await checkouts.returnPrimary({ projectId, sessionId: secondSessionId });

      await checkouts.sweep({
        resting: async ({ sessionId: id }) => id === sessionId,
      });
      await expect(fs.access(resting.path)).rejects.toThrow();
      await expect(fs.access(left.path)).rejects.toThrow();
      expect(await git(rootPath, ["show", "work/22222222:kept.md"])).toBe(
        "k\n",
      );
      expect(await git(rootPath, [`show`, `${left.branch}:left.md`])).toBe(
        "l\n",
      );
    });

    it("tells the agent where it works every turn", async () => {
      expect(await checkouts.notice({ projectId, sessionId })).toBeNull();
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      const notice = await checkouts.notice({ projectId, sessionId });
      expect(notice).toContain(worktree);
      expect(notice).toContain(rootPath);
      expect(await checkouts.notice({ projectId, sessionId })).toBe(notice);
    });

    it("cannot be chosen before the project has a commit", async () => {
      const empty = path.join(tmpDir, "empty");
      await fs.mkdir(empty);
      await git(empty, ["init", "-b", "main"]);
      const fresh = new SessionCheckouts({
        pglite,
        worktreesDirectory: path.join(tmpDir, "worktrees"),
        projectRoot: () => empty,
      });
      expect(await fresh.worktreesAvailable(projectId)).toBe(false);
      await expect(fresh.plan({ projectId, sessionId })).rejects.toThrow(
        "starts from a commit",
      );
    });

    it("sets up once per checkout, again after it is put away", async () => {
      await checkouts.plan({ projectId, sessionId });
      const { path: worktree } = await agentCheckout();
      const setup = (environment: string) =>
        checkouts.setup({
          projectId,
          sessionId,
          workingDirectory: worktree,
          environment,
          personalAllowed: false,
          timeoutMinutes: 1,
          signal: new AbortController().signal,
          onRun: async () => {},
        });
      const command = "echo ran >> ../setup-runs.txt";
      expect((await setup(command)).outcome).toEqual({ status: "succeeded" });
      expect((await setup(command)).outcome).toEqual({ status: "current" });
      const failed = await setup("echo broken && exit 3");
      expect(failed.outcome).toMatchObject({
        status: "failed",
        exitCode: 3,
        parts: ["environment"],
      });
      expect(
        failed.outcome.status === "failed" && failed.outcome.log,
      ).toContain("broken");
      await checkouts.putAway({ projectId, sessionId });
      const again = await agentCheckout();
      expect(again.path).toBe(worktree);
      expect((await setup(command)).outcome).toEqual({ status: "succeeded" });
      expect(
        await fs.readFile(
          path.join(path.dirname(worktree), "setup-runs.txt"),
          "utf8",
        ),
      ).toBe("ran\nran\n");
    });
  });
});

describe("parseWorktreePorcelain", () => {
  it("parses nul-delimited paths and branches without splitting spaces", () => {
    expect(
      parseWorktreePorcelain(
        "worktree /tmp/main tree\0HEAD abc\0branch refs/heads/main\0\0" +
          "worktree /tmp/other\0HEAD def\0detached\0\0",
      ),
    ).toEqual([
      { path: "/tmp/main tree", branch: "main", detached: false },
      { path: "/tmp/other", branch: null, detached: true },
    ]);
  });
});
