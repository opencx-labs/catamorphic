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
      projectRoot: (id) => (id === projectId ? rootPath : undefined),
    });
    await checkouts.init();
  });

  afterEach(async () => {
    await pglite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps a new session on primary until it creates a worktree", async () => {
    expect(await checkouts.resolve({ projectId, sessionId })).toBe(rootPath);

    const created = await checkouts.createManaged({ projectId, sessionId });
    expect(created.kind).toBe("managed");
    expect(created.branch).toMatch(/^catamorphic\/22222222/);
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
        branch: created.branch,
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

    expect(first.branch).toBe("catamorphic/22222222");
    expect(second.branch).toBe("catamorphic/22222222-1");
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
    const managedPath = path.join(
      rootPath,
      ".catamorphic",
      "worktrees",
      sessionId,
    );
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
      git(rootPath, [
        "show-ref",
        "--verify",
        "refs/heads/catamorphic/22222222",
      ]),
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

  it("names and checkpoints a detached external worktree for review", async () => {
    const external = path.join(tmpDir, "detached-external");
    await git(rootPath, ["worktree", "add", "--detach", external]);
    await checkouts.adopt({ projectId, sessionId, path: external });
    await fs.writeFile(path.join(external, "review.txt"), "ready\n");

    const prepared = await checkouts.preparePullRequest({
      projectId,
      sessionId,
      message: "Prepare review",
    });

    expect(prepared.branch).toBe("catamorphic/22222222-review");
    expect((await git(external, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(external, ["branch", "--show-current"])).trim()).toBe(
      prepared.branch,
    );
  });

  it("falls back to primary when a bound worktree disappears", async () => {
    const created = await checkouts.createManaged({ projectId, sessionId });
    await fs.rm(created.path, { recursive: true, force: true });
    expect(await checkouts.resolve({ projectId, sessionId })).toBe(rootPath);
    expect(checkouts.takeRecoveryWarning(sessionId)).toContain(
      "returned to the primary project checkout",
    );
    expect(checkouts.takeRecoveryWarning(sessionId)).toBeNull();
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
