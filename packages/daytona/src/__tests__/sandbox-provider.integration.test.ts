import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaytonaSandboxProvider } from "../sandbox-provider.js";

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const EXTERNAL_INTEGRATIONS =
  process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";

const describeIf =
  DAYTONA_API_KEY && EXTERNAL_INTEGRATIONS ? describe : describe.skip;
const RUN_ID = crypto.randomUUID();

describeIf("DaytonaSandboxProvider (integration)", () => {
  let provider: DaytonaSandboxProvider;
  const createdSandboxIds: string[] = [];

  beforeAll(() => {
    provider = new DaytonaSandboxProvider({
      apiKey: DAYTONA_API_KEY,
    });
  });

  afterAll(async () => {
    for (const id of createdSandboxIds) {
      try {
        await provider.destroySandbox(id);
      } catch {
        // already destroyed
      }
    }
  }, 120_000);

  it("creates a sandbox and gets its status", async () => {
    const handle = await provider.createSandbox({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-provider-integration", run: RUN_ID },
    });

    createdSandboxIds.push(handle.providerId);

    expect(handle.id).toBeTruthy();
    expect(handle.providerId).toBeTruthy();
    expect(handle.status).toBe("started");

    const status = await provider.getSandboxStatus(handle.providerId);
    expect(status).toBe("started");
  }, 120_000);

  it("executes a command in the sandbox", async () => {
    const handle = await provider.createSandbox({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-provider-exec", run: RUN_ID },
    });
    createdSandboxIds.push(handle.providerId);

    const result = await provider.executeCommand(
      handle.providerId,
      'echo "hello from daytona"',
    );

    expect(result.exitCode).toBe(0);
    expect(result.result).toContain("hello from daytona");
  }, 120_000);

  it("uploads and downloads files", async () => {
    const handle = await provider.createSandbox({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-provider-files", run: RUN_ID },
    });
    createdSandboxIds.push(handle.providerId);

    await provider.uploadFiles(
      handle.providerId,
      {
        "test.txt": "hello world",
        "nested/deep.txt": "deep content",
      },
      "/home/daytona",
    );

    const content = await provider.downloadFile(
      handle.providerId,
      "/home/daytona/test.txt",
    );
    expect(content).toBe("hello world");

    const deepContent = await provider.downloadFile(
      handle.providerId,
      "/home/daytona/nested/deep.txt",
    );
    expect(deepContent).toBe("deep content");
  }, 120_000);

  it("executes TypeScript via bun", async () => {
    const handle = await provider.createSandbox({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-provider-bun", run: RUN_ID },
    });
    createdSandboxIds.push(handle.providerId);

    await provider.uploadFiles(
      handle.providerId,
      {
        "test-script.ts": "console.log(JSON.stringify({ sum: 1 + 2 }));",
      },
      "/home/daytona",
    );

    const result = await provider.executeCommand(
      handle.providerId,
      "bun run /home/daytona/test-script.ts",
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.result.trim());
    expect(parsed).toEqual({ sum: 3 });
  }, 120_000);

  it("stops and restarts a sandbox", async () => {
    const handle = await provider.createSandbox({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-provider-lifecycle", run: RUN_ID },
    });
    createdSandboxIds.push(handle.providerId);

    await provider.stopSandbox(handle.providerId);

    const stopped = await provider.getSandboxStatus(handle.providerId);
    expect(stopped).toBe("stopped");

    await provider.startSandbox(handle.providerId);

    const restarted = await provider.getSandboxStatus(handle.providerId);
    expect(restarted).toBe("started");
  }, 120_000);

  it("initializes a git repo via command", async () => {
    const handle = await provider.createSandbox({
      language: "typescript",
      autoStopInterval: 0,
      labels: { test: "daytona-provider-git", run: RUN_ID },
    });
    createdSandboxIds.push(handle.providerId);

    await provider.executeCommand(
      handle.providerId,
      "git init /home/daytona/test-repo && cd /home/daytona/test-repo && git config user.email test@test.com && git config user.name Test",
    );

    await provider.uploadFiles(
      handle.providerId,
      { "hello.ts": 'export const x = "hi";' },
      "/home/daytona/test-repo",
    );

    await provider.executeCommand(
      handle.providerId,
      "cd /home/daytona/test-repo && git add . && git commit -m 'init'",
    );

    const result = await provider.executeCommand(
      handle.providerId,
      "cd /home/daytona/test-repo && git log --oneline",
    );

    expect(result.exitCode).toBe(0);
    expect(result.result).toContain("init");
  }, 120_000);
});
