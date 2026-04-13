import { Daytona } from "@daytonaio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaytonaProjectRepo } from "../daytona-project-repo.js";

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;

const describeIf = DAYTONA_API_KEY ? describe : describe.skip;

describeIf("DaytonaProjectRepo (integration)", () => {
  let client: Daytona;
  let sandboxId: string;
  let repo: DaytonaProjectRepo;
  const repoPath = "project";

  beforeAll(async () => {
    client = new Daytona({ apiKey: DAYTONA_API_KEY });
    const sandbox = await client.create({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-project-repo-integration" },
    });
    sandboxId = sandbox.id;

    await sandbox.process.executeCommand(
      `git init --initial-branch=main ${repoPath}`,
    );
    await sandbox.process.executeCommand(
      `cd ${repoPath} && git config user.email test@catamorphic.dev && git config user.name "Catamorphic Test"`,
    );

    repo = new DaytonaProjectRepo({
      sandboxId,
      projectId: "test-project",
      repoPath,
      client,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      const sandbox = await client.get(sandboxId);
      await client.delete(sandbox);
    } catch {
      // already destroyed
    }
  }, 120_000);

  it("writes and reads a file", async () => {
    await repo.writeFile("src/hello.ts", 'export const greeting = "hi";');
    const content = await repo.readFile("src/hello.ts");
    expect(content).toBe('export const greeting = "hi";');
  }, 60_000);

  it("lists files (excluding .git)", async () => {
    await repo.writeFile("README.md", "# Test Project");
    const files = await repo.listFiles();
    expect(files).toContain("src/hello.ts");
    expect(files).toContain("README.md");
    expect(files.some((f) => f.includes(".git"))).toBe(false);
  }, 60_000);

  it("reads all files as a map", async () => {
    const all = await repo.readAllFiles();
    expect(all["src/hello.ts"]).toBe('export const greeting = "hi";');
    expect(all["README.md"]).toBe("# Test Project");
  }, 60_000);

  it("deletes a file", async () => {
    await repo.writeFile("tmp.txt", "temporary");
    await repo.deleteFile("tmp.txt");

    const files = await repo.listFiles();
    expect(files).not.toContain("tmp.txt");
  }, 60_000);

  it("commits and returns a 40-char SHA", async () => {
    const sha = await repo.commit("Initial commit", {
      name: "Catamorphic Test",
      email: "test@catamorphic.dev",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("resolveRef returns the HEAD SHA", async () => {
    const head = await repo.resolveRef("HEAD");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("log returns commit history", async () => {
    await repo.writeFile("v2.txt", "version 2");
    await repo.commit("Second commit", {
      name: "Catamorphic Test",
      email: "test@catamorphic.dev",
    });

    const commits = await repo.log({ maxCount: 10 });
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits[0]?.message).toContain("Second commit");
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0]?.author.name).toBe("Catamorphic Test");
  }, 60_000);

  it("commit after changes produces a new SHA", async () => {
    const sha1 = await repo.resolveRef("HEAD");

    await repo.writeFile("v3.txt", "version 3");
    const sha2 = await repo.commit("Third commit", {
      name: "Catamorphic Test",
      email: "test@catamorphic.dev",
    });

    expect(sha2).not.toBe(sha1);
  }, 60_000);
});
