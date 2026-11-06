import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FsBackend,
  InMemoryObjectStore,
  ObjectRemoteBackend,
  OriginDraftRepo,
  ProjectManager,
} from "@catamorphic/git";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  checkpointDraft,
  draftStoreFolder,
} from "../services/draft-workspace.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTHOR = { name: "Work Agent", email: "agent@work.software" };

let dir: string;
let manager: ProjectManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-workspace-"));
  manager = new ProjectManager(
    new FsBackend(path.join(dir, "projects")),
    new ObjectRemoteBackend({ store: new InMemoryObjectStore() }),
  );
  await (await manager.create(TENANT, PROJECT, { name: "p" })).dispose();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const draft = async () => {
  const opened = await manager.openDraft({
    tenantId: TENANT,
    projectId: PROJECT,
    externalUserId: "alice",
  });
  if (!(opened instanceof OriginDraftRepo)) throw new Error("Not a draft");
  return opened;
};

it("checkpoints an agent turn in a server draft at the draft's tip", async () => {
  const repo = await draft();
  await repo.writeFile("notes.md", "turn one");
  const tip = await repo.resolveRef("HEAD");
  expect(
    await checkpointDraft({
      repo: await draft(),
      message: "Turn",
      author: AUTHOR,
    }),
  ).toBe(tip);
});

it("gives a server draft's agent a store folder to sync around turns", async () => {
  const folder = await draftStoreFolder({
    projectManager: manager,
    repo: await draft(),
    tenantId: TENANT,
    projectId: PROJECT,
    externalUserId: "alice",
  });
  expect(folder).toBeTruthy();
  expect((await fs.stat(folder ?? "")).isDirectory()).toBe(true);
});
