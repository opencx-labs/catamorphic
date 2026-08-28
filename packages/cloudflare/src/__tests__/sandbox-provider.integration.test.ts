import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudflareSandboxProvider } from "../sandbox-provider.js";

const CF_SANDBOX_URL = process.env.CLOUDFLARE_SANDBOX_API_URL;
const CF_SANDBOX_KEY = process.env.CLOUDFLARE_SANDBOX_API_KEY;
// Explicit opt-in — `CLOUDFLARE_SANDBOX_API_URL` alone is not enough because
// it's typically set to a localhost URL during dev even when the bridge
// isn't running. Set `CF_SANDBOX_INTEGRATION=1` in CI or before running
// these tests manually.
const CF_INTEGRATION = process.env.CF_SANDBOX_INTEGRATION === "1";
const EXTERNAL_INTEGRATIONS =
  process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";

const describeIf =
  CF_SANDBOX_URL && CF_INTEGRATION && EXTERNAL_INTEGRATIONS
    ? describe
    : describe.skip;

describeIf("CloudflareSandboxProvider (integration)", () => {
  let provider: CloudflareSandboxProvider;
  const createdSandboxIds: string[] = [];

  beforeAll(() => {
    provider = new CloudflareSandboxProvider({
      apiUrl: CF_SANDBOX_URL!,
      apiKey: CF_SANDBOX_KEY,
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

  it("creates a sandbox and reports it as running after first exec", async () => {
    const handle = await provider.createSandbox({});
    createdSandboxIds.push(handle.providerId);

    expect(handle.providerId).toMatch(/^[a-z2-7]+$/);

    const result = await provider.executeCommand(
      handle.providerId,
      "echo hello from cloudflare",
    );
    expect(result.exitCode).toBe(0);
    expect(result.result).toContain("hello from cloudflare");

    const status = await provider.getSandboxStatus(handle.providerId);
    expect(status).toBe("started");
  }, 180_000);

  it("uploads + reads back files under /workspace", async () => {
    const handle = await provider.createSandbox({});
    createdSandboxIds.push(handle.providerId);

    await provider.uploadFiles(
      handle.providerId,
      {
        "test.txt": "hello world",
        "nested/deep.txt": "deep content",
      },
      `${provider.workspaceRoot}/project`,
    );

    const shallow = await provider.downloadFile(
      handle.providerId,
      `${provider.workspaceRoot}/project/test.txt`,
    );
    expect(shallow).toBe("hello world");

    const deep = await provider.downloadFile(
      handle.providerId,
      `${provider.workspaceRoot}/project/nested/deep.txt`,
    );
    expect(deep).toBe("deep content");
  }, 180_000);

  it("executes TypeScript via bun after uploading a script", async () => {
    const handle = await provider.createSandbox({});
    createdSandboxIds.push(handle.providerId);

    const projectDir = `${provider.workspaceRoot}/project`;
    await provider.uploadFiles(
      handle.providerId,
      { "script.ts": "console.log(JSON.stringify({ sum: 1 + 2 }));" },
      projectDir,
    );

    const result = await provider.executeCommand(
      handle.providerId,
      `cd ${projectDir} && bun run script.ts`,
    );

    expect(result.exitCode).toBe(0);
    const lastLine = result.result.trim().split("\n").pop() ?? "";
    expect(JSON.parse(lastLine)).toEqual({ sum: 3 });
  }, 180_000);
});
