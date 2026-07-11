import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FsBackend,
  fetchRemote,
  ProjectManager,
  type ProjectRepo,
  PushNotFastForwardError,
  pull,
  push,
} from "@catamorphic/git";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommit, wrapObject } from "../git-object-codec.js";
import { InMemoryObjectStore } from "../in-memory-object-store.js";
import { S3RemoteBackend } from "../s3-remote-backend.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const USER_A = "user_a";
const USER_B = "user_b";
const AUTHOR_A = { name: "Alice", email: "alice@test.dev" };
const AUTHOR_B = { name: "Bob", email: "bob@test.dev" };

describe("git object codec", () => {
  it("computes the same oid as isomorphic-git for blobs", async () => {
    const data = new TextEncoder().encode("export const v = 1;\n");
    const { sha } = wrapObject({ type: "blob", data });
    const { oid } = await git.hashBlob({ object: data });
    expect(sha).toBe(oid);
  });

  it("parses commit author, parents, and message", () => {
    const commitText = [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "author Alice <alice@test.dev> 1752249600 +0300",
      "committer Alice <alice@test.dev> 1752249600 +0300",
      "",
      "add feature",
      "",
    ].join("\n");
    const parsed = parseCommit(new TextEncoder().encode(commitText));
    expect(parsed.tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(parsed.parents).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(parsed.author).toEqual({
      name: "Alice",
      email: "alice@test.dev",
      timestamp: 1752249600,
    });
    expect(parsed.message.trim()).toBe("add feature");
  });
});

describe("S3RemoteBackend lifecycle", () => {
  it("initRemote is idempotent and exists/deleteRemote work", async () => {
    const backend = new S3RemoteBackend({ store: new InMemoryObjectStore() });
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
    await backend.initRemote(TENANT, PROJECT);
    await backend.initRemote(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(true);
    await backend.deleteRemote(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
  });

  it("rejects non-uuid tenant/project ids", async () => {
    const backend = new S3RemoteBackend({ store: new InMemoryObjectStore() });
    await expect(backend.initRemote("../evil", PROJECT)).rejects.toThrow(
      /Invalid UUID/,
    );
  });
});

describe("S3OriginRepo ref CAS", () => {
  const SHA_1 = "a".repeat(40);
  const SHA_2 = "b".repeat(40);

  async function origin() {
    const backend = new S3RemoteBackend({ store: new InMemoryObjectStore() });
    await backend.initRemote(TENANT, PROJECT);
    return { backend };
  }

  it("creates a ref with expected: null and rejects re-creation", async () => {
    const { backend } = await origin();
    await backend.withOrigin(TENANT, PROJECT, async (repo) => {
      await repo.updateRef({
        ref: "refs/heads/main",
        sha: SHA_1,
        expected: null,
      });
      expect(await repo.resolveRef("refs/heads/main")).toBe(SHA_1);
      await expect(
        repo.updateRef({ ref: "refs/heads/main", sha: SHA_2, expected: null }),
      ).rejects.toThrow(/moved/);
    });
  });

  it("updates when expected matches and rejects when it does not", async () => {
    const { backend } = await origin();
    await backend.withOrigin(TENANT, PROJECT, async (repo) => {
      await repo.updateRef({
        ref: "refs/heads/main",
        sha: SHA_1,
        expected: null,
      });
      await repo.updateRef({
        ref: "refs/heads/main",
        sha: SHA_2,
        expected: SHA_1,
      });
      expect(await repo.resolveRef("refs/heads/main")).toBe(SHA_2);
      await expect(
        repo.updateRef({
          ref: "refs/heads/main",
          sha: SHA_1,
          expected: SHA_1,
        }),
      ).rejects.toThrow(/moved/);
    });
  });

  it("force-updates when expected is omitted", async () => {
    const { backend } = await origin();
    await backend.withOrigin(TENANT, PROJECT, async (repo) => {
      await repo.updateRef({ ref: "refs/heads/main", sha: SHA_1 });
      await repo.updateRef({ ref: "refs/heads/main", sha: SHA_2 });
      expect(await repo.resolveRef("refs/heads/main")).toBe(SHA_2);
    });
  });
});

describe("git-sync over S3RemoteBackend", () => {
  let tmpDir: string;
  let manager: ProjectManager;
  let remote: S3RemoteBackend;
  let repoA: ProjectRepo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-s3-"));
    remote = new S3RemoteBackend({
      store: new InMemoryObjectStore(),
      keyPrefix: "test/",
    });
    manager = new ProjectManager(new FsBackend(tmpDir), remote);
    repoA = await manager.create(TENANT, PROJECT, {
      name: "s3-sync-test",
      externalUserId: USER_A,
    });
  });

  afterEach(async () => {
    await repoA.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("create initializes the origin and pushes the initial commit", async () => {
    await remote.withOrigin(TENANT, PROJECT, async (origin) => {
      const mainSha = await origin.resolveRef("refs/heads/main");
      expect(mainSha).toMatch(/^[0-9a-f]{40}$/);
      const log = await origin.log("refs/heads/main");
      expect(log).toHaveLength(1);
      expect(log[0]?.message.trim()).toBe("Initial commit");
      expect(log[0]?.author.name).toBe("Catamorphic");
    });
  });

  it("push transfers new commits to the origin", async () => {
    await repoA.writeFile("src/new.ts", "export const v = 1;");
    const sha = await repoA.commit("add new", AUTHOR_A);
    const result = await push({
      dev: repoA,
      remote,
      tenantId: TENANT,
      projectId: PROJECT,
    });
    expect(result.sha).toBe(sha);
    const remoteSha = await remote.withOrigin(TENANT, PROJECT, (origin) =>
      origin.resolveRef("refs/heads/main"),
    );
    expect(remoteSha).toBe(sha);
  });

  it("seeds a second user's working copy from the origin", async () => {
    await repoA.writeFile("src/feature.ts", "export const feature = true;");
    await repoA.commit("add feature", AUTHOR_A);
    await push({ dev: repoA, remote, tenantId: TENANT, projectId: PROJECT });

    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      const files = await repoB.readAllFiles();
      expect(files["src/feature.ts"]).toBe("export const feature = true;");
      expect(files["package.json"]).toContain("s3-sync-test");
    } finally {
      await repoB.dispose();
    }
  });

  it("push throws when not a fast-forward", async () => {
    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/b.ts", "b");
      await repoB.commit("B: add b", AUTHOR_B);
      await push({ dev: repoB, remote, tenantId: TENANT, projectId: PROJECT });

      await repoA.writeFile("src/a.ts", "a2");
      await repoA.commit("A: change a", AUTHOR_A);
      await expect(
        push({ dev: repoA, remote, tenantId: TENANT, projectId: PROJECT }),
      ).rejects.toBeInstanceOf(PushNotFastForwardError);
    } finally {
      await repoB.dispose();
    }
  });

  it("fetchRemote updates the tracking ref", async () => {
    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/b.ts", "b");
      const bSha = await repoB.commit("B: add b", AUTHOR_B);
      await push({ dev: repoB, remote, tenantId: TENANT, projectId: PROJECT });

      const result = await fetchRemote({
        dev: repoA,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      expect(result.sha).toBe(bSha);
      expect(await repoA.resolveRef("refs/remotes/origin/main")).toBe(bSha);
    } finally {
      await repoB.dispose();
    }
  });

  it("pull detects conflicts when the same file diverges", async () => {
    await repoA.writeFile("src/shared.ts", "base");
    await repoA.commit("base", AUTHOR_A);
    await push({ dev: repoA, remote, tenantId: TENANT, projectId: PROJECT });

    const repoB = await manager.openDev(TENANT, PROJECT, USER_B);
    try {
      await repoB.writeFile("src/shared.ts", "theirs version");
      await repoB.commit("B: change shared", AUTHOR_B);
      await push({ dev: repoB, remote, tenantId: TENANT, projectId: PROJECT });

      await repoA.writeFile("src/shared.ts", "ours version");
      await repoA.commit("A: change shared", AUTHOR_A);

      const result = await pull({
        dev: repoA,
        remote,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      expect(result.status).toBe("conflict");
      const conflict = result.conflicts.find((c) => c.path === "src/shared.ts");
      expect(conflict?.ours).toBe("ours version");
      expect(conflict?.theirs).toBe("theirs version");
      expect(conflict?.base).toBe("base");
    } finally {
      await repoB.dispose();
    }
  });

  it("listRefs sees branches pushed to the origin", async () => {
    await repoA.writeFile("src/x.ts", "x");
    await repoA.commit("x", AUTHOR_A);
    const headSha = await repoA.resolveRef("HEAD");
    await push({
      dev: repoA,
      remote,
      tenantId: TENANT,
      projectId: PROJECT,
      remoteBranch: "work/2026-07-11_16-00",
    });

    const refs = await remote.withOrigin(TENANT, PROJECT, (origin) =>
      origin.listRefs("refs/heads/"),
    );
    const names = refs.map((r) => r.ref);
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/heads/work/2026-07-11_16-00");
    expect(
      refs.find((r) => r.ref === "refs/heads/work/2026-07-11_16-00")?.sha,
    ).toBe(headSha);
  });

  it("log walks history with messages and authors", async () => {
    await repoA.writeFile("src/one.ts", "1");
    await repoA.commit("one", AUTHOR_A);
    await repoA.writeFile("src/two.ts", "2");
    await repoA.commit("two", AUTHOR_B);
    await push({ dev: repoA, remote, tenantId: TENANT, projectId: PROJECT });

    const log = await remote.withOrigin(TENANT, PROJECT, (origin) =>
      origin.log("refs/heads/main"),
    );
    expect(log.map((c) => c.message.trim())).toEqual([
      "two",
      "one",
      "Initial commit",
    ]);
    expect(log[0]?.author.email).toBe("bob@test.dev");
    expect(log.every((c) => c.timestamp > 0)).toBe(true);
  });
});
