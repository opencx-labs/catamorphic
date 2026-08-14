import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandboxProvider } from "../sandbox-provider.js";

describe("LocalProcessSandboxProvider", () => {
  let root: string;
  let provider: LocalProcessSandboxProvider;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-lp-test-"));
    provider = new LocalProcessSandboxProvider({ root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips files through virtual /workspace paths", async () => {
    const sandbox = await provider.createSandbox({});
    await provider.uploadFiles(
      sandbox.id,
      { "project/src/hello.ts": "export const hi = 1;\n" },
      "/workspace",
    );
    const content = await provider.downloadFile(
      sandbox.id,
      "/workspace/project/src/hello.ts",
    );
    expect(content).toBe("export const hi = 1;\n");
    // The real directory lives inside this sandbox's own root.
    expect(
      fs.existsSync(
        path.join(root, sandbox.id, "workspace", "project/src/hello.ts"),
      ),
    ).toBe(true);
  });

  it("never leaks the host process env into commands", async () => {
    process.env.CATAMORPHIC_TEST_HOST_SECRET = "leak-me";
    try {
      const sandbox = await provider.createSandbox({});
      const result = await provider.executeCommand(
        sandbox.id,
        'echo "host=[$CATAMORPHIC_TEST_HOST_SECRET] passed=[$EXPLICIT]"',
        { env: { EXPLICIT: "yes" } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.result).toContain("host=[] passed=[yes]");
    } finally {
      delete process.env.CATAMORPHIC_TEST_HOST_SECRET;
    }
  });

  it("gives each sandbox its own HOME and applies create-time envVars", async () => {
    const sandbox = await provider.createSandbox({
      envVars: { SANDBOX_WIDE: "present" },
    });
    const result = await provider.executeCommand(
      sandbox.id,
      'echo "$HOME|$SANDBOX_WIDE"',
    );
    expect(result.result.trim()).toBe(
      `${path.join(root, sandbox.id, "home")}|present`,
    );
  });

  it("kills commands that exceed the timeout", async () => {
    const sandbox = await provider.createSandbox({});
    const started = Date.now();
    const result = await provider.executeCommand(sandbox.id, "sleep 30", {
      timeout: 1,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).toBe(124);
    expect(result.result).toContain("timed out");
  });

  it("maps the runtime sibling directory inside the sandbox", async () => {
    const sandbox = await provider.createSandbox({});
    await provider.uploadFiles(
      sandbox.id,
      { "entry.txt": "runtime" },
      "/workspace/project/../runtime",
    );
    expect(
      fs.readFileSync(
        path.join(root, sandbox.id, "workspace", "runtime", "entry.txt"),
        "utf-8",
      ),
    ).toBe("runtime");
  });

  it("contains traversal inside the sandbox and rejects relative paths", async () => {
    const sandbox = await provider.createSandbox({});
    // Absolute traversal normalizes within the virtual root: it can never
    // reach the host's /etc/passwd, only a (nonexistent) path inside the
    // sandbox directory.
    const error = await provider
      .downloadFile(sandbox.id, "/workspace/../../../etc/passwd")
      .then(() => null)
      .catch((e: unknown) => e as NodeJS.ErrnoException);
    expect(error?.code).toBe("ENOENT");
    expect(error?.message).toContain(path.join(root, sandbox.id));

    await expect(
      provider.downloadFile(sandbox.id, "../outside.txt"),
    ).rejects.toThrow(/must be absolute/);
  });

  it("destroys a sandbox's directory", async () => {
    const sandbox = await provider.createSandbox({});
    expect(await provider.getSandboxStatus(sandbox.id)).toBe("started");
    await provider.destroySandbox(sandbox.id);
    expect(await provider.getSandboxStatus(sandbox.id)).toBe("stopped");
  });
});
