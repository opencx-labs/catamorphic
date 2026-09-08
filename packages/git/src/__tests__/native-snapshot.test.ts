import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { NativeProjectRepo } from "../native-project-repo.js";
import { ProjectManager } from "../project-manager.js";

it("applies snapshot selection and budgets through the native checkout adapter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cat-native-snapshot-"));
  const manager = new ProjectManager(new FsBackend(root));
  const managed = await manager.create(
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "f1e2d3c4-b5a6-7890-dcba-fedcba987654",
    { name: "test" },
  );
  const repo = new NativeProjectRepo(
    managed.projectId,
    managed.repoPath,
    async () => {},
  );
  try {
    await repo.writeFile("workflow.ts", "export const value = 12345;");
    const head = await repo.commit("source", {
      name: "Test",
      email: "test@example.com",
    });
    const media = await fs.open(path.join(repo.repoPath, "video.mp4"), "w");
    await media.truncate(256 * 1024 * 1024);
    await media.close();
    const options = { filter: (file: string) => file.endsWith(".ts") };
    expect(await repo.readAllFiles(options)).toEqual({
      "workflow.ts": "export const value = 12345;",
    });
    expect(await repo.readAllFilesAtRef(head, options)).toEqual({
      "workflow.ts": "export const value = 12345;",
    });
    await expect(
      repo.readAllFiles({ ...options, maxTotalBytes: 8 }),
    ).rejects.toThrow("snapshot exceeds");
    await expect(
      repo.readAllFilesAtRef(head, { ...options, maxTotalBytes: 8 }),
    ).rejects.toThrow("snapshot exceeds");
    await expect(
      repo.readBlobAtRef(head, "workflow.ts", { maxBytes: 8 }),
    ).rejects.toThrow("snapshot limit");
  } finally {
    await repo.dispose();
    await managed.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
