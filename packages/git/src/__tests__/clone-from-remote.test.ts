import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { FsRemoteBackend } from "../fs-remote-backend.js";
import { ProjectManager } from "../project-manager.js";
import { ProjectRepoImpl } from "../project-repo.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";

vi.mock("../network.js", () => ({
  cloneFromRemote: vi.fn(async (opts: { repoPath: string }) => {
    // Simulate a clone by committing a file the way a real clone would
    // materialize history in the fresh repo.
    await fs.writeFile(path.join(opts.repoPath, "README.md"), "# hello\n");
    const repo = new ProjectRepoImpl("x", opts.repoPath, async () => {});
    const sha = await repo.commit("Imported from remote", {
      name: "octo",
      email: "octo@example.com",
    });
    return { sha, remoteBranch: "master" };
  }),
}));

describe("ProjectManager.create with cloneFrom", () => {
  let tmpDir: string;
  let manager: ProjectManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-clone-"));
    manager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
      new FsRemoteBackend(path.join(tmpDir, "remotes")),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("clones instead of scaffolding and pushes history to origin", async () => {
    const { cloneFromRemote } = await import("../network.js");

    const repo = await manager.create(TENANT, PROJECT, {
      name: "imported",
      initialFiles: { "should-not-exist.ts": "nope" },
      cloneFrom: {
        url: "https://github.com/octo/hello.git",
        credentials: { username: "x-access-token", password: "tok" },
      },
    });

    expect(cloneFromRemote).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://github.com/octo/hello.git" }),
    );

    const files = await repo.listFiles();
    expect(files).toContain("README.md");
    // No scaffold, no initialFiles: imported history stays pristine.
    expect(files).not.toContain("contracts/package.json");
    expect(files).not.toContain("should-not-exist.ts");

    const commits = await repo.log();
    expect(commits[0]?.message.trim()).toBe("Imported from remote");

    // History must land on the internal origin so openDev seeding works.
    const sha = await repo.resolveRef("HEAD");
    const remote = manager.remoteBackend;
    const originSha = await remote?.withOrigin(TENANT, PROJECT, (origin) =>
      origin.resolveRef("refs/heads/main"),
    );
    expect(originSha).toBe(sha);

    await repo.dispose();
  });
});
