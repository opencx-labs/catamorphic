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
  type HarnessDownloadProgress,
  harnessDownloadLine,
  watchHarnessDownloads,
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

  // A dropped connection never errors by itself: the turn waiting on it
  // used to say "Working" for as long as the app stayed open.
  it("gives up on a download that stops receiving, and the next attempt starts over", async () => {
    const fixture = await componentFixture();
    const archive = await fs.readFile(fixture.archive);
    let attempts = 0;
    const store = new HarnessComponentStore({
      rootDir: fixture.installRoot,
      artifacts: { codex: fixture.artifact },
      fetchImpl: async (_url, init) => {
        attempts += 1;
        if (attempts > 1) return new Response(archive);
        const signal = init?.signal;
        // Half the archive, then silence until the request is aborted.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(archive.subarray(0, archive.byteLength / 2));
              signal?.addEventListener("abort", () =>
                controller.error(signal.reason),
              );
            },
          }),
        );
      },
      preferInstalled: false,
      stallTimeoutMs: 50,
    });

    await expect(store.ensure("codex")).rejects.toThrow(
      /^Fake Codex needs a one-time component download\. The download received nothing for \d+ seconds\. Check your internet connection/,
    );
    expect((await store.ensure("codex")).source).toBe("downloaded");
    expect(attempts).toBe(2);
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

describe("harnessDownloadLine", () => {
  const progress = (
    displayName: string,
    receivedBytes: number,
    totalBytes: number,
  ) => ({
    harness: "claude-code" as const,
    displayName,
    receivedBytes,
    totalBytes,
  });

  it("counts every download a turn waits for, by the megabyte", () => {
    expect(
      harnessDownloadLine([progress("Claude Code", 110_400_000, 221_000_000)]),
    ).toBe("Downloading Claude Code: 110 of 221 MB");
    expect(
      harnessDownloadLine([
        progress("Claude Code", 221_000_000, 221_000_000),
        progress("Bun", 30_000_000, 60_000_000),
      ]),
    ).toBe("Downloading Claude Code and Bun: 251 of 281 MB");
  });

  it("says when the downloads are in and unpacking", () => {
    expect(
      harnessDownloadLine([
        progress("Claude Code", 221_000_000, 221_000_000),
        progress("Bun", 60_000_000, 60_000_000),
      ]),
    ).toBe("Setting up Claude Code and Bun");
  });

  it("counts megabytes when the registry gives no size", () => {
    expect(harnessDownloadLine([progress("Bun", 12_400_000, 0)])).toBe(
      "Downloading Bun: 12 MB",
    );
  });
});

describe("watchHarnessDownloads", () => {
  function fakeStore() {
    const listeners = new Set<(progress: HarnessDownloadProgress) => void>();
    return {
      store: {
        onProgress: (listener: (progress: HarnessDownloadProgress) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      tick: (progress: HarnessDownloadProgress) => {
        for (const listener of listeners) listener(progress);
      },
      listening: () => listeners.size,
    };
  }
  const claude = (receivedBytes: number): HarnessDownloadProgress => ({
    harness: "claude-code",
    displayName: "Claude Code",
    receivedBytes,
    totalBytes: 100_000_000,
  });
  const bun = (receivedBytes: number): HarnessDownloadProgress => ({
    harness: "bun",
    displayName: "Bun",
    receivedBytes,
    totalBytes: 24_000_000,
  });

  it("tells the turn its downloads a line a second, then that the harness starts", () => {
    const { store, tick, listening } = fakeStore();
    const lines: string[] = [];
    let clock = 0;
    const finish = watchHarnessDownloads({
      store,
      harness: "claude-code",
      report: (line) => lines.push(line),
      now: () => clock,
    });
    // Bun ticked first; the harness still leads the line.
    tick(bun(0));
    clock = 1_000;
    tick(claude(10_000_000));
    clock = 1_400;
    tick(claude(20_000_000));
    clock = 2_000;
    tick(claude(30_000_000));
    // Another harness's download is not this turn's.
    tick({ ...claude(5_000_000), harness: "codex", displayName: "Codex" });
    clock = 2_100;
    tick(claude(100_000_000));
    tick(bun(24_000_000));
    finish(true);
    expect(lines).toEqual([
      "Downloading Bun: 0 of 24 MB",
      "Downloading Claude Code and Bun: 10 of 124 MB",
      "Downloading Claude Code and Bun: 30 of 124 MB",
      "Setting up Claude Code and Bun",
      "Starting Claude Code",
    ]);
    expect(listening()).toBe(0);
  });

  it("says nothing when everything is already here, or when getting ready failed", () => {
    const quiet = fakeStore();
    const lines: string[] = [];
    watchHarnessDownloads({
      store: quiet.store,
      harness: "claude-code",
      report: (line) => lines.push(line),
    })(true);
    expect(lines).toEqual([]);

    const failed = fakeStore();
    const finish = watchHarnessDownloads({
      store: failed.store,
      harness: "codex",
      report: (line) => lines.push(line),
    });
    failed.tick({
      ...claude(1_000_000),
      harness: "codex",
      displayName: "Codex",
    });
    finish(false);
    expect(lines).toEqual(["Downloading Codex: 1 of 100 MB"]);
    expect(failed.listening()).toBe(0);
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
