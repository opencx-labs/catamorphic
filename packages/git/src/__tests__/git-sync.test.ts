import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { FsRemoteBackend } from "../fs-remote-backend.js";
import {
  fetchRemote,
  PushNotFastForwardError,
  pull,
  push,
} from "../git-sync.js";
import { ProjectManager } from "../project-manager.js";
import type { ProjectRepo, RemoteBackend } from "../types.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const USER_A = "user_a";
const USER_B = "user_b";
const AUTHOR_A = { name: "Alice", email: "alice@test.dev" };
const AUTHOR_B = { name: "Bob", email: "bob@test.dev" };

describe("git-sync", () => {
  let tmpDir: string;
  let devDir: string;
  let originDir: string;
  let manager: ProjectManager;
  let remote: RemoteBackend;
  let repoA: ProjectRepo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-sync-"));
    devDir = path.join(tmpDir, "dev");
    originDir = path.join(tmpDir, "origin");
    await fs.mkdir(devDir, { recursive: true });
    await fs.mkdir(originDir, { recursive: true });

    remote = new FsRemoteBackend(originDir);
    manager = new ProjectManager(new FsBackend(devDir), remote);
    repoA = await manager.create(TENANT, PROJECT, {
      name: "sync-test",
      externalUserId: USER_A,
    });
  });

  afterEach(async () => {
    await repoA.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("create initializes origin and pushes initial commit", async () => {
    await remote.withOrigin(TENANT, PROJECT, async (origin) => {
      const mainSha = await origin.resolveRef("refs/heads/main");
      expect(mainSha).toMatch(/^[0-9a-f]{40}$/);
      const log = await origin.log("refs/heads/main");
      expect(log).toHaveLength(1);
      expect(log[0]?.message.trim()).toBe("Initial commit");
    });
  });

  it("push transfers new commits to origin", async () => {
    await repoA.writeFile("src/new.ts", "export const v = 1;");
    const sha = await repoA.commit("add new", AUTHOR_A);
    const result = await push({
      dev: repoA,
      remote,
      tenantId: TENANT,
      projectId: PROJECT,
    });
    expect(result.sha).toBe(sha);
    const remoteSha = await remote.withOrigin(TENANT, PROJECT, async (origin) =>
      origin.resolveRef("refs/heads/main"),
    );
    expect(remoteSha).toBe(sha);
  });

  it("push throws when not a fast-forward", async () => {
    await repoA.writeFile("src/a.ts", "a");
    await repoA.commit("A: add a", AUTHOR_A);
    await push({ dev: repoA, remote, tenantId: TENANT, projectId: PROJECT });

    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/b.ts", "b");
      await repoB.commit("B: add b", AUTHOR_B);
      await push({
        dev: repoB,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });

      await repoA.writeFile("src/a.ts", "a2");
      await repoA.commit("A: change a", AUTHOR_A);

      await expect(
        push({
          dev: repoA,
          remote,
          tenantId: TENANT,
          projectId: PROJECT,
        }),
      ).rejects.toBeInstanceOf(PushNotFastForwardError);
    } finally {
      await repoB.dispose();
    }
  });

  it("fetchRemote brings new commits into dev repo tracking ref", async () => {
    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/b.ts", "b");
      const bSha = await repoB.commit("B: add b", AUTHOR_B);
      await push({
        dev: repoB,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });

      const result = await fetchRemote({
        dev: repoA,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      expect(result.sha).toBe(bSha);
      const trackingSha = await repoA.resolveRef("refs/remotes/origin/main");
      expect(trackingSha).toBe(bSha);
    } finally {
      await repoB.dispose();
    }
  });

  it("pull fast-forwards when local is behind", async () => {
    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/b.ts", "b");
      const bSha = await repoB.commit("B: add b", AUTHOR_B);
      await push({
        dev: repoB,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });

      const result = await pull({
        dev: repoA,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      expect(result.status).toBe("clean");
      const headSha = await repoA.resolveRef("HEAD");
      expect(headSha).toBe(bSha);
      const content = await repoA.readFile("src/b.ts");
      expect(content).toBe("b");
    } finally {
      await repoB.dispose();
    }
  });

  it("pull returns conflict when same file diverges", async () => {
    await repoA.writeFile("src/shared.ts", "base");
    await repoA.commit("base", AUTHOR_A);
    await push({ dev: repoA, remote, tenantId: TENANT, projectId: PROJECT });

    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/shared.ts", "theirs version");
      await repoB.commit("B: change shared", AUTHOR_B);
      await push({
        dev: repoB,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });

      await repoA.writeFile("src/shared.ts", "ours version");
      await repoA.commit("A: change shared", AUTHOR_A);

      const result = await pull({
        dev: repoA,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      expect(result.status).toBe("conflict");
      expect(result.conflicts.map((c) => c.path)).toContain("src/shared.ts");
      const conflict = result.conflicts.find((c) => c.path === "src/shared.ts");
      expect(conflict?.ours).toBe("ours version");
      expect(conflict?.theirs).toBe("theirs version");
      expect(conflict?.base).toBe("base");
    } finally {
      await repoB.dispose();
    }
  });

  it("pull is up-to-date when remote equals local", async () => {
    const result = await pull({
      dev: repoA,
      remote,
      tenantId: TENANT,
      projectId: PROJECT,
    });
    expect(result.status).toBe("up-to-date");
  });
});
