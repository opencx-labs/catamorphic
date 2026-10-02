import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c as createArchive } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MIN_VERSION,
  type HarnessArtifact,
  HarnessComponentStore,
} from "./harness-components.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("HarnessComponentStore", () => {
  it("runs the person's own Claude Code when it is new enough, else downloads Work's", async () => {
    const fixture = await componentFixture();
    let downloads = 0;
    let installedVersion = "2.1.0";
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: { "claude-code": fixture.artifact },
      fetchImpl: async () => {
        downloads += 1;
        return new Response(await fs.readFile(fixture.archive));
      },
      preferInstalled: false,
      installedClaudeCode: {
        find: async () => ({
          executablePath: "/home/person/.local/share/claude/versions/x",
          commandPath: "/home/person/.local/bin/claude",
          version: installedVersion,
        }),
        update: async () => {
          installedVersion = CLAUDE_CODE_MIN_VERSION;
          return "Successfully updated";
        },
      },
    });

    // Older than the SDK's release: Work's pinned copy, and an update offer.
    expect(await store.claudeCodeStatus()).toMatchObject({
      using: "work",
      installed: { version: "2.1.0" },
      minVersion: CLAUDE_CODE_MIN_VERSION,
    });
    expect((await store.ensure("claude-code")).source).toBe("downloaded");
    expect(downloads).toBe(1);

    // Updated through its own updater: the person's copy runs from now on.
    const updated = await store.updateInstalledClaudeCode();
    expect(updated.status.using).toBe("installed");
    expect(await store.ensure("claude-code")).toEqual({
      executablePath: "/home/person/.local/share/claude/versions/x",
      pathEntries: [],
      source: "system",
    });
    expect(downloads).toBe(1);
  });

  it("never downloads Claude Code when a new enough install is present", async () => {
    const fixture = await componentFixture();
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: { "claude-code": fixture.artifact },
      fetchImpl: async () => {
        throw new Error("no download expected");
      },
      preferInstalled: false,
      installedClaudeCode: {
        find: async () => ({
          executablePath: "/usr/local/bin/claude",
          commandPath: "/usr/local/bin/claude",
          version: "99.0.0",
        }),
        update: async () => "",
      },
    });
    expect((await store.ensure("claude-code")).source).toBe("system");
  });

  it("downloads, verifies, atomically installs, and reuses a component", async () => {
    const fixture = await componentFixture();
    let downloads = 0;
    const fetchImpl: typeof fetch = async () => {
      downloads += 1;
      return new Response(await fs.readFile(fixture.archive));
    };
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: { codex: fixture.artifact },
      fetchImpl,
      preferInstalled: false,
    });

    const [first, concurrent] = await Promise.all([
      store.ensure("codex"),
      store.ensure("codex"),
    ]);
    const reused = await store.ensure("codex");

    expect(downloads).toBe(1);
    expect(first).toEqual(concurrent);
    expect(reused).toEqual(first);
    expect(first.source).toBe("downloaded");
    expect(await fs.readFile(first.executablePath, "utf8")).toBe("fake-cli\n");
    expect(first.pathEntries).toHaveLength(1);
  });

  it("reports download progress, and none once the component is here", async () => {
    const fixture = await componentFixture();
    const archive = await fs.readFile(fixture.archive);
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: { codex: fixture.artifact },
      fetchImpl: async () =>
        new Response(archive, {
          headers: { "content-length": String(archive.byteLength) },
        }),
      preferInstalled: false,
    });
    const ticks: Array<{ receivedBytes: number; totalBytes: number }> = [];
    const stop = store.onProgress((progress) => {
      expect(progress.harness).toBe("codex");
      ticks.push(progress);
    });

    await store.ensure("codex");
    expect(ticks[0]).toMatchObject({
      receivedBytes: 0,
      totalBytes: archive.byteLength,
    });
    expect(ticks.at(-1)).toMatchObject({
      receivedBytes: archive.byteLength,
      totalBytes: archive.byteLength,
    });

    const settled = ticks.length;
    await store.ensure("codex");
    stop();
    expect(ticks).toHaveLength(settled);
  });

  it("rejects an archive that does not match the shipped integrity pin", async () => {
    const fixture = await componentFixture();
    const fetchImpl: typeof fetch = async () =>
      new Response(await fs.readFile(fixture.archive));
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: {
        codex: {
          ...fixture.artifact,
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
      },
      fetchImpl,
      preferInstalled: false,
    });

    await expect(store.ensure("codex")).rejects.toThrow(
      "component integrity verification failed",
    );
    await expect(
      fs.stat(
        path.join(
          fixture.installRoot,
          "codex",
          "test-version",
          `${process.platform}-${process.arch}`,
          ".integrity",
        ),
      ),
    ).rejects.toThrow();
  });

  it("installs the managed Bun runtime through the same verified store", async () => {
    const fixture = await componentFixture();
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: { bun: { ...fixture.artifact, displayName: "Bun" } },
      fetchImpl: async () => new Response(await fs.readFile(fixture.archive)),
      preferInstalled: false,
    });

    const bun = await store.ensure("bun");
    expect(bun.executablePath).toContain(`${path.sep}bun${path.sep}`);
    expect(bun.pathEntries).toHaveLength(1);
  });
});

async function componentFixture(): Promise<{
  archive: string;
  installRoot: string;
  artifact: HarnessArtifact;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-component-"));
  temporaryRoots.push(root);
  const packageRoot = path.join(root, "source", "package");
  await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "bin", "fake"), "fake-cli\n", {
    mode: 0o755,
  });
  const archive = path.join(root, "component.tgz");
  await createArchive(
    { cwd: path.join(root, "source"), file: archive, gzip: true },
    ["package"],
  );
  const digest = createHash("sha512")
    .update(await fs.readFile(archive))
    .digest("base64");
  const integrity: `sha512-${string}` = `sha512-${digest}`;
  return {
    archive,
    installRoot: path.join(root, "installed"),
    artifact: {
      displayName: "Fake Codex",
      version: "test-version",
      packageName: "@test/codex",
      installedPackageName: "@test/codex-platform",
      tarballUrl: "https://registry.npmjs.org/@test/codex/-/codex.tgz",
      integrity,
      executableRelativePath: path.join("bin", "fake"),
      pathEntryRelativePaths: ["bin"],
    },
  };
}
