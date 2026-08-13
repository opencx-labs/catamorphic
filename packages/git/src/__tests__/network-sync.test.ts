import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { syncWithNetworkRemote } from "../network-sync.js";
import { ProjectManager } from "../project-manager.js";
import type { ProjectRepo } from "../types.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";
const AUTHOR = { name: "Catamorphic", email: "system@catamorphic.dev" };

// The network layer is mocked: `remote.sha` is what a fetch would find, and
// pushes are recorded. Divergent "remote" histories are simulated by
// committing on a side branch of the same repo — exactly like a real fetch,
// the commits are then present in the odb without being on `main`.
const remote = vi.hoisted(() => ({
  sha: null as string | null,
  pushes: [] as Array<{ ref?: string; remoteBranch?: string }>,
}));

vi.mock("../network.js", () => ({
  fetchFromRemote: vi.fn(async () => ({ sha: remote.sha })),
  pushToRemote: vi.fn(async (opts: { ref?: string; remoteBranch?: string }) => {
    remote.pushes.push({ ref: opts.ref, remoteBranch: opts.remoteBranch });
  }),
}));

describe("syncWithNetworkRemote", () => {
  let tmpDir: string;
  let repo: ProjectRepo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-nsync-"));
    const manager = new ProjectManager(new FsBackend(tmpDir));
    repo = await manager.create(TENANT, PROJECT, { name: "synced" });
    remote.sha = null;
    remote.pushes = [];
  });

  afterEach(async () => {
    await repo.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const sync = () =>
    syncWithNetworkRemote({
      dev: repo,
      url: "https://example.com/owner/repo.git",
      remoteBranch: "main",
      author: AUTHOR,
      now: new Date(Date.UTC(2026, 7, 13, 12, 30)),
    });

  const commitLocal = async (file: string, content: string) => {
    await repo.writeFile(file, content);
    return repo.commit(`add ${file}`, AUTHOR);
  };

  /** Simulate remote-only history: commit on a side branch, back to main. */
  const commitRemoteOnly = async (file: string, content: string) => {
    const base = await repo.resolveRef("refs/heads/main");
    await repo.createBranch("remote-sim");
    await repo.writeFile(file, content);
    await repo.commit(`remote ${file}`, AUTHOR);
    const sha = await repo.resolveRef("HEAD");
    await repo.moveBranch("main", base);
    await repo.checkout("main");
    remote.sha = sha;
    return sha;
  };

  it("pushes when the remote branch does not exist yet", async () => {
    const result = await sync();
    expect(result.status).toBe("pushed");
    expect(remote.pushes).toEqual([{ ref: "main", remoteBranch: "main" }]);
  });

  it("reports up-to-date when shas match", async () => {
    remote.sha = await repo.resolveRef("refs/heads/main");
    const result = await sync();
    expect(result.status).toBe("up-to-date");
    expect(remote.pushes).toEqual([]);
  });

  it("pushes when local is strictly ahead", async () => {
    remote.sha = await repo.resolveRef("refs/heads/main");
    await commitLocal("local.txt", "local");
    const result = await sync();
    expect(result.status).toBe("pushed");
    expect(remote.pushes).toEqual([{ ref: "main", remoteBranch: "main" }]);
  });

  it("fast-forwards when the remote is strictly ahead and the tree is clean", async () => {
    const sha = await commitRemoteOnly("remote.txt", "remote");
    const result = await sync();
    expect(result.status).toBe("pulled");
    expect(await repo.resolveRef("refs/heads/main")).toBe(sha);
    expect(await repo.readFile("remote.txt")).toBe("remote");
    expect(remote.pushes).toEqual([]);
  });

  it("defers instead of touching a dirty tree", async () => {
    await commitRemoteOnly("remote.txt", "remote");
    await repo.writeFile("draft.txt", "in progress");
    const before = await repo.resolveRef("refs/heads/main");
    const result = await sync();
    expect(result.status).toBe("deferred");
    expect(await repo.resolveRef("refs/heads/main")).toBe(before);
    expect(await repo.readFile("draft.txt")).toBe("in progress");
    expect(remote.pushes).toEqual([]);
  });

  it("merges cleanly diverged histories and pushes the result", async () => {
    await commitRemoteOnly("remote.txt", "remote");
    await commitLocal("local.txt", "local");
    const result = await sync();
    expect(result.status).toBe("merged");
    expect(await repo.readFile("remote.txt")).toBe("remote");
    expect(await repo.readFile("local.txt")).toBe("local");
    expect(remote.pushes).toEqual([{ ref: "main", remoteBranch: "main" }]);
  });

  it("pushes a rescue branch on merge conflict, leaving the tree untouched", async () => {
    await commitLocal("file.txt", "base");
    await commitRemoteOnly("file.txt", "remote edit");
    await commitLocal("file.txt", "local edit");
    const before = await repo.resolveRef("refs/heads/main");

    const result = await sync();
    expect(result.status).toBe("diverged");
    expect(result.rescueBranch).toBe("catamorphic/diverged-2026-08-13_12-30");
    expect(remote.pushes).toEqual([
      { ref: "main", remoteBranch: "catamorphic/diverged-2026-08-13_12-30" },
    ]);
    // No conflict markers, no moved main — the user's tree is sacred.
    expect(await repo.resolveRef("refs/heads/main")).toBe(before);
    expect(await repo.readFile("file.txt")).toBe("local edit");
  });

  it("no-ops when the repo is not on main", async () => {
    await repo.createBranch("work/2026-08-13_12-00");
    const result = await sync();
    expect(result.status).toBe("no-op");
    expect(remote.pushes).toEqual([]);
  });
});
