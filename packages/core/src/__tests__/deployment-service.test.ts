import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DraftRefNotAllowedError,
  FsBackend,
  InMemoryObjectStore,
  ObjectRemoteBackend,
  OriginDraftRepo,
  ProjectManager,
} from "@catamorphic/git";
import { draftRef } from "@catamorphic/workflow/project-layout";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentService } from "../services/deployment-service.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "alice";
const BOB = "bob@example.com";

/**
 * Members' drafts as refs in the project origin (ADR 0191). Two managers
 * over one object origin stand for two replicas with their own disks.
 */
describe("DeploymentService with draft refs", () => {
  let tmpDir: string;
  let origin: ObjectRemoteBackend;
  let replicaA: ProjectManager;
  let replicaB: ProjectManager;
  let serviceA: DeploymentService;
  let serviceB: DeploymentService;

  const replica = (name: string) =>
    new ProjectManager(new FsBackend(path.join(tmpDir, name)), origin);

  const draftOf = async (
    manager: ProjectManager,
    externalUserId: string,
  ): Promise<OriginDraftRepo> => {
    const draft = await manager.openDraft({
      tenantId: TENANT,
      projectId: PROJECT,
      externalUserId,
    });
    if (!(draft instanceof OriginDraftRepo))
      throw new Error("A server project's draft is a ref");
    return draft;
  };

  const write = async (
    manager: ProjectManager,
    externalUserId: string,
    files: Record<string, string>,
  ) => {
    const draft = await draftOf(manager, externalUserId);
    for (const [file, content] of Object.entries(files))
      await draft.writeFile(file, content);
  };

  const mainFiles = async () => {
    const draft = await draftOf(replicaA, "reader");
    return draft.readAllFilesAtRef("main");
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-deploy-"));
    origin = new ObjectRemoteBackend({ store: new InMemoryObjectStore() });
    replicaA = replica("a");
    replicaB = replica("b");
    const created = await replicaA.create(TENANT, PROJECT, {
      name: "deploy-test",
    });
    await created.dispose();
    serviceA = new DeploymentService(replicaA);
    serviceB = new DeploymentService(replicaB);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("starts clean, with the draft following main", async () => {
    const status = await serviceA.getStatus(TENANT, PROJECT, ALICE);
    expect(status).toMatchObject({
      branch: "main",
      dirty: false,
      modifiedFiles: [],
      ahead: 0,
      behind: 0,
    });
    expect(status.baseCommit).toBe(status.remoteHead);
    const deployed = await serviceA.deploy(TENANT, PROJECT, ALICE);
    expect(deployed.status).toBe("nothing-to-deploy");
  });

  it("a write on one replica is read, checked, and deployed on another", async () => {
    await write(replicaA, ALICE, { "src/a.ts": "export const a = 1;\n" });
    const onB = await draftOf(replicaB, ALICE);
    expect(await onB.readFile("src/a.ts")).toBe("export const a = 1;\n");
    expect(await onB.listFiles({ prefix: "src" })).toEqual(["src/a.ts"]);
    const status = await serviceB.getStatus(TENANT, PROJECT, ALICE);
    expect(status).toMatchObject({
      dirty: true,
      modifiedFiles: ["src/a.ts"],
      ahead: 1,
      behind: 0,
    });
    const diff = await serviceB.workdirDiff(TENANT, PROJECT, ALICE);
    expect(diff).toEqual([
      {
        path: "src/a.ts",
        kind: "added",
        before: null,
        after: "export const a = 1;\n",
      },
    ]);

    const before = status.remoteHead;
    const result = await serviceB.deploy(TENANT, PROJECT, ALICE, {
      message: "Add a",
    });
    expect(result.status).toBe("deployed");
    // One commit on main with the deploy message, whatever the draft held.
    const log = await onB.log({ ref: "main", maxCount: 2 });
    expect(log[0]).toMatchObject({ sha: result.commitSha, message: "Add a\n" });
    expect(log[1]?.sha).toBe(before);
    expect(log[0]?.author.name).toBe(ALICE);
    expect((await mainFiles())["src/a.ts"]).toBe("export const a = 1;\n");
    // The draft is gone: the member follows main again.
    await origin.withOrigin(TENANT, PROJECT, async (repo) =>
      expect(await repo.resolveRef(draftRef(ALICE))).toBeNull(),
    );
    expect((await serviceA.deploy(TENANT, PROJECT, ALICE)).status).toBe(
      "nothing-to-deploy",
    );
  });

  it("drafts survive a replica losing its disk", async () => {
    await write(replicaA, ALICE, { "notes.md": "keep me" });
    await fs.rm(path.join(tmpDir, "a"), { recursive: true, force: true });
    const restarted = replica("a");
    const draft = await draftOf(restarted, ALICE);
    expect(await draft.readFile("notes.md")).toBe("keep me");
  });

  it("squashes many draft writes into one published commit", async () => {
    for (let i = 0; i < 5; i++)
      await write(i % 2 ? replicaA : replicaB, ALICE, {
        [`src/${i}.ts`]: `${i}`,
      });
    expect((await serviceA.getStatus(TENANT, PROJECT, ALICE)).ahead).toBe(5);
    const before = (await serviceA.getStatus(TENANT, PROJECT, ALICE))
      .remoteHead;
    const result = await serviceA.deploy(TENANT, PROJECT, ALICE, {
      message: "Five files",
    });
    const draft = await draftOf(replicaA, ALICE);
    const [tip, parent] = await draft.log({ ref: "main", maxCount: 2 });
    expect(tip?.sha).toBe(result.commitSha);
    expect(parent?.sha).toBe(before);
  });

  it("two writers racing on one draft both land", async () => {
    const drafts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        draftOf(i % 2 ? replicaA : replicaB, ALICE),
      ),
    );
    await Promise.all(
      drafts.map((draft, i) => draft.writeFile(`race/${i}.txt`, `${i}`)),
    );
    const files = await drafts[0]?.readAllFiles();
    for (let i = 0; i < 6; i++) expect(files?.[`race/${i}.txt`]).toBe(`${i}`);
    expect((await serviceA.getStatus(TENANT, PROJECT, ALICE)).ahead).toBe(6);
  });

  it("checks expected content in the same compare-and-swap", async () => {
    const draft = await draftOf(replicaA, ALICE);
    await draft.writeFile("doc.md", "one");
    await expect(
      draft.write({
        changes: [{ path: "doc.md", content: "three" }],
        expected: { "doc.md": "two" },
      }),
    ).rejects.toThrow("changed since it was read");
    await draft.write({
      changes: [{ path: "doc.md", content: "two" }],
      expected: { "doc.md": "one" },
    });
    expect(await draft.readFile("doc.md")).toBe("two");
  });

  it("discard deletes the draft", async () => {
    await write(replicaA, ALICE, { "src/a.ts": "hi" });
    const result = await serviceB.discardDraft(TENANT, PROJECT, ALICE);
    expect(result).toEqual({ discarded: true, branch: "main" });
    expect(await serviceA.workdirDiff(TENANT, PROJECT, ALICE)).toEqual([]);
    const draft = await draftOf(replicaA, ALICE);
    await expect(draft.readFile("src/a.ts")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("a draft whose edits were undone publishes nothing and is cleared", async () => {
    await write(replicaA, ALICE, { "tmp.txt": "x" });
    const draft = await draftOf(replicaA, ALICE);
    await draft.deleteFile("tmp.txt");
    expect((await serviceA.getStatus(TENANT, PROJECT, ALICE)).dirty).toBe(
      false,
    );
    expect((await serviceA.deploy(TENANT, PROJECT, ALICE)).status).toBe(
      "nothing-to-deploy",
    );
    await origin.withOrigin(TENANT, PROJECT, async (repo) =>
      expect(await repo.resolveRef(draftRef(ALICE))).toBeNull(),
    );
  });

  it("drafts are private to their member", async () => {
    await write(replicaA, BOB, { "secret.md": "bob's" });
    const alice = await draftOf(replicaA, ALICE);
    await expect(alice.readFile("secret.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(alice.resolveRef(draftRef(BOB))).rejects.toBeInstanceOf(
      DraftRefNotAllowedError,
    );
    expect(await alice.readBlobAtRef(draftRef(BOB), "secret.md")).toBeNull();
  });

  it("merges when main moved since the draft began", async () => {
    await write(replicaA, ALICE, { "src/alice.ts": "alice" });
    await write(replicaB, BOB, { "src/bob.ts": "bob" });
    await serviceB.deploy(TENANT, PROJECT, BOB, { message: "Bob" });
    const behind = await serviceA.getStatus(TENANT, PROJECT, ALICE);
    expect(behind).toMatchObject({
      ahead: 1,
      behind: 1,
      modifiedFiles: ["src/alice.ts"],
    });
    const result = await serviceA.deploy(TENANT, PROJECT, ALICE, {
      message: "Alice",
    });
    expect(result.status).toBe("deployed");
    const files = await mainFiles();
    expect(files["src/alice.ts"]).toBe("alice");
    expect(files["src/bob.ts"]).toBe("bob");
    const draft = await draftOf(replicaA, ALICE);
    const [tip, parent] = await draft.log({ ref: "main", maxCount: 2 });
    expect(tip?.message).toBe("Alice\n");
    expect(parent?.message).toBe("Bob\n");
  });

  it("reports conflicts, keeps the draft, and publishes the resolution", async () => {
    await write(replicaA, ALICE, { "src/shared.ts": "base\n" });
    await serviceA.deploy(TENANT, PROJECT, ALICE, { message: "Base" });
    // Alice's draft begins at the base; Bob publishes over it meanwhile.
    await write(replicaA, ALICE, { "src/shared.ts": "alice\n" });
    await write(replicaB, BOB, { "src/shared.ts": "bob\n" });
    await serviceB.deploy(TENANT, PROJECT, BOB, { message: "Bob" });
    const mainBefore = (await serviceA.getStatus(TENANT, PROJECT, ALICE))
      .remoteHead;

    const conflict = await serviceB.deploy(TENANT, PROJECT, ALICE, {
      message: "Alice",
    });
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflicts).toEqual([
      {
        path: "src/shared.ts",
        base: "base\n",
        ours: "alice\n",
        theirs: "bob\n",
      },
    ]);
    expect((await serviceA.getStatus(TENANT, PROJECT, ALICE)).remoteHead).toBe(
      mainBefore,
    );
    expect(
      await (await draftOf(replicaA, ALICE)).readFile("src/shared.ts"),
    ).toBe("alice\n");

    const resolved = await serviceA.resolveConflicts(TENANT, PROJECT, ALICE, {
      resolutions: { "src/shared.ts": "merged\n" },
      message: "Resolve",
    });
    expect(resolved.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const status = await serviceB.getStatus(TENANT, PROJECT, ALICE);
    expect(status.behind).toBe(0);
    const published = await serviceB.deploy(TENANT, PROJECT, ALICE, {
      message: "Alice resolved",
    });
    expect(published.status).toBe("deployed");
    expect((await mainFiles())["src/shared.ts"]).toBe("merged\n");
  });

  it("pull brings published changes into a draft", async () => {
    await write(replicaA, ALICE, { "src/alice.ts": "alice" });
    await write(replicaB, BOB, { "src/bob.ts": "bob" });
    await serviceB.deploy(TENANT, PROJECT, BOB);
    const pulled = await serviceA.pullFromRemote(TENANT, PROJECT, ALICE);
    expect(pulled.status).toBe("clean");
    const draft = await draftOf(replicaB, ALICE);
    expect(await draft.readFile("src/bob.ts")).toBe("bob");
    expect(await draft.readFile("src/alice.ts")).toBe("alice");
    expect(await serviceA.getStatus(TENANT, PROJECT, ALICE)).toMatchObject({
      behind: 0,
      modifiedFiles: ["src/alice.ts"],
    });
  });

  it("a draft without changes simply follows main on pull", async () => {
    await write(replicaA, ALICE, { "tmp.txt": "x" });
    await (await draftOf(replicaA, ALICE)).deleteFile("tmp.txt");
    await write(replicaB, BOB, { "src/bob.ts": "bob" });
    await serviceB.deploy(TENANT, PROJECT, BOB);
    expect((await serviceA.pullFromRemote(TENANT, PROJECT, ALICE)).status).toBe(
      "up-to-date",
    );
    expect(await (await draftOf(replicaA, ALICE)).readFile("src/bob.ts")).toBe(
      "bob",
    );
  });

  it("publishing files commits on top of main and leaves the draft alone", async () => {
    await write(replicaA, ALICE, { "drafts/agent.ts": "unfinished" });
    const result = await serviceB.deploy(TENANT, PROJECT, ALICE, {
      message: "Publish one file",
      files: { ".work/project.json": "{}" },
    });
    expect(result.status).toBe("deployed");
    const files = await mainFiles();
    expect(files[".work/project.json"]).toBe("{}");
    expect(files["drafts/agent.ts"]).toBeUndefined();
    const status = await serviceA.getStatus(TENANT, PROJECT, ALICE);
    expect(status.modifiedFiles).toEqual(["drafts/agent.ts"]);
  });

  it("refuses a publish the guard rejects and publishes nothing", async () => {
    await write(replicaA, ALICE, { ".work/roles/admin.json": "{}" });
    const before = (await serviceA.getStatus(TENANT, PROJECT, ALICE))
      .remoteHead;
    await expect(
      serviceA.deploy(TENANT, PROJECT, ALICE, {
        guardPublishedPaths: (paths) => {
          if (paths.includes(".work/roles/admin.json"))
            throw new Error("roles:write required");
        },
      }),
    ).rejects.toThrow("roles:write required");
    expect((await serviceA.getStatus(TENANT, PROJECT, ALICE)).remoteHead).toBe(
      before,
    );
  });

  it("tells enablements about each published revision", async () => {
    const published: Array<{ projectId: string; commitSha: string }> = [];
    const notified = new DeploymentService(replicaA, async (input) => {
      published.push(input);
    });
    await write(replicaA, ALICE, { "src/a.ts": "hello" });
    const result = await notified.deploy(TENANT, PROJECT, ALICE);
    expect(published).toEqual([
      { projectId: PROJECT, commitSha: result.remoteSha },
    ]);
  });

  it("lists published commits for any member", async () => {
    await write(replicaA, ALICE, { "src/a.ts": "hello" });
    await serviceA.deploy(TENANT, PROJECT, ALICE, { message: "Hello" });
    const commits = await serviceB.listCommits(TENANT, PROJECT, BOB);
    expect(commits[0]?.message).toBe("Hello\n");
  });
});
