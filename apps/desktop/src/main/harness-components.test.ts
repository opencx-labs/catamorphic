import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c as createArchive } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
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
