import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentService } from "../services/deployment-service.js";

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ALICE = "alice";
const BOB = "bob";

describe("DeploymentService", () => {
  let tmpDir: string;
  let service: DeploymentService;
  let manager: ProjectManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-deploy-"));
    const devDir = path.join(tmpDir, "dev");
    const originDir = path.join(tmpDir, "origin");
    await fs.mkdir(devDir, { recursive: true });
    await fs.mkdir(originDir, { recursive: true });
    manager = new ProjectManager(
      new FsBackend(devDir),
      new FsRemoteBackend(originDir),
    );
    await manager.create(TENANT, PROJECT, {
      name: "deploy-test",
      externalUserId: ALICE,
    });
    service = new DeploymentService(manager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("getStatus returns clean state for fresh repo", async () => {
    const status = await service.getStatus(TENANT, PROJECT, ALICE);
    expect(status.branch).toBe("main");
    expect(status.dirty).toBe(false);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("deploy creates work branch for dirty main, pushes to origin", async () => {
    const repo = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await repo.writeFile("src/a.ts", "hello");
    } finally {
      await repo.dispose();
    }

    const result = await service.deploy(TENANT, PROJECT, ALICE, {
      message: "first deploy",
    });
    expect(result.status).toBe("deployed");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.remoteSha).toBe(result.commitSha);
  });

  it("deploy returns nothing-to-deploy when clean", async () => {
    const result = await service.deploy(TENANT, PROJECT, ALICE);
    expect(result.status).toBe("nothing-to-deploy");
  });

  it("workdirDiff reports edits before deploy", async () => {
    const repo = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await repo.writeFile("src/a.ts", "hi");
    } finally {
      await repo.dispose();
    }
    const diff = await service.workdirDiff(TENANT, PROJECT, ALICE);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.path).toBe("src/a.ts");
    expect(diff[0]?.kind).toBe("added");
  });

  it("discardDraft clears workdir and deletes work branch", async () => {
    const repo = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await repo.writeFile("src/a.ts", "hi");
    } finally {
      await repo.dispose();
    }
    await service.ensureWorkBranch(TENANT, PROJECT, ALICE);

    const result = await service.discardDraft(TENANT, PROJECT, ALICE);
    expect(result.discarded).toBe(true);

    const diff = await service.workdirDiff(TENANT, PROJECT, ALICE);
    expect(diff).toHaveLength(0);

    const status = await service.getStatus(TENANT, PROJECT, ALICE);
    expect(status.branch).toBe("main");
  });

  it("pull banner: user sees ahead/behind after peer deploys", async () => {
    const aliceStatus0 = await service.getStatus(TENANT, PROJECT, ALICE);
    expect(aliceStatus0.behind).toBe(0);

    const bobRepo = await manager.openDev(TENANT, PROJECT, BOB);
    try {
      await bobRepo.writeFile("src/bob.ts", "hi bob");
    } finally {
      await bobRepo.dispose();
    }
    await service.deploy(TENANT, PROJECT, BOB);

    const aliceStatus1 = await service.getStatus(TENANT, PROJECT, ALICE);
    expect(aliceStatus1.behind).toBe(1);
    expect(aliceStatus1.remoteHead).toBeTruthy();
  });

  it("pull fast-forwards when user is behind", async () => {
    const bobRepo = await manager.openDev(TENANT, PROJECT, BOB);
    try {
      await bobRepo.writeFile("src/bob.ts", "hi bob");
    } finally {
      await bobRepo.dispose();
    }
    await service.deploy(TENANT, PROJECT, BOB);

    const pullResult = await service.pullFromRemote(TENANT, PROJECT, ALICE);
    expect(pullResult.status).toBe("clean");
  });

  it("conflict: deploy blocks when same file diverged", async () => {
    const aliceRepo = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await aliceRepo.writeFile("src/shared.ts", "base");
    } finally {
      await aliceRepo.dispose();
    }
    await service.deploy(TENANT, PROJECT, ALICE);

    const bobRepo = await manager.openDev(TENANT, PROJECT, BOB);
    try {
      await bobRepo.writeFile("src/shared.ts", "bob version");
    } finally {
      await bobRepo.dispose();
    }
    await service.deploy(TENANT, PROJECT, BOB);

    const aliceRepo2 = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await aliceRepo2.writeFile("src/shared.ts", "alice version");
    } finally {
      await aliceRepo2.dispose();
    }
    const result = await service.deploy(TENANT, PROJECT, ALICE);
    expect(result.status).toBe("conflict");
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("resolveConflicts writes resolutions and commits", async () => {
    const aliceRepo = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await aliceRepo.writeFile("src/shared.ts", "base");
    } finally {
      await aliceRepo.dispose();
    }
    await service.deploy(TENANT, PROJECT, ALICE);

    const bobRepo = await manager.openDev(TENANT, PROJECT, BOB);
    try {
      await bobRepo.writeFile("src/shared.ts", "bob");
    } finally {
      await bobRepo.dispose();
    }
    await service.deploy(TENANT, PROJECT, BOB);

    const aliceRepo2 = await manager.openDev(TENANT, PROJECT, ALICE);
    try {
      await aliceRepo2.writeFile("src/shared.ts", "alice");
    } finally {
      await aliceRepo2.dispose();
    }
    await service.deploy(TENANT, PROJECT, ALICE);

    const resolved = await service.resolveConflicts(TENANT, PROJECT, ALICE, {
      resolutions: { "src/shared.ts": "merged" },
      message: "manual merge",
    });
    expect(resolved.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
