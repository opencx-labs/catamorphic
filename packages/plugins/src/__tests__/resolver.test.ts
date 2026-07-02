import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPluginResolver, PluginResolutionError } from "../resolver.js";

interface FakePackage {
  dirName: string;
  packageName: string;
  version?: string;
  extraFiles?: Record<string, string>;
  manifest?: Record<string, unknown> | null;
}

async function setupPlugins(packages: FakePackage[]): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-resolver-"));
  for (const pkg of packages) {
    const pkgDir = path.join(rootDir, pkg.dirName);
    await fs.mkdir(pkgDir, { recursive: true });
    const pkgJson: Record<string, unknown> = {
      name: pkg.packageName,
    };
    if (pkg.version) pkgJson.version = pkg.version;
    if (pkg.manifest !== null) {
      pkgJson.catamorphic = pkg.manifest ?? {
        displayName: pkg.packageName,
        description: "",
        secrets: [],
      };
    }
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );
    for (const [rel, content] of Object.entries(pkg.extraFiles ?? {})) {
      const abs = path.join(pkgDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
  }
  return rootDir;
}

describe("LocalPluginResolver", () => {
  let rootDir: string;

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("lists packages with a valid catamorphic manifest", async () => {
    rootDir = await setupPlugins([
      {
        dirName: "workflow-sdk",
        packageName: "@opencx/workflow-sdk",
        version: "0.0.1",
        manifest: {
          displayName: "OpenCX",
          secrets: [{ name: "OPENCX_API_KEY", label: "Key", required: true }],
        },
      },
      {
        dirName: "other-plugin",
        packageName: "other-plugin",
        manifest: { displayName: "Other" },
      },
      {
        dirName: "not-a-plugin",
        packageName: "not-a-plugin",
        manifest: null,
      },
    ]);

    const resolver = new LocalPluginResolver({ rootDir });
    const plugins = await resolver.list();

    expect(plugins.map((p) => p.packageName)).toEqual([
      "@opencx/workflow-sdk",
      "other-plugin",
    ]);
    expect(plugins[0]?.version).toBe("0.0.1");
    expect(plugins[0]?.manifest.secrets).toHaveLength(1);
  });

  it("resolves a scoped package by the unscoped directory name", async () => {
    rootDir = await setupPlugins([
      {
        dirName: "workflow-sdk",
        packageName: "@opencx/workflow-sdk",
        manifest: { displayName: "OpenCX" },
      },
    ]);
    const resolver = new LocalPluginResolver({ rootDir });
    const plugin = await resolver.resolve("@opencx/workflow-sdk");
    expect(plugin.packageName).toBe("@opencx/workflow-sdk");
    expect(plugin.manifest.displayName).toBe("OpenCX");
  });

  it("returns an empty list when the root directory does not exist", async () => {
    const resolver = new LocalPluginResolver({
      rootDir: "/definitely/nonexistent/path-xyz",
    });
    const plugins = await resolver.list();
    expect(plugins).toEqual([]);
  });

  it("throws PluginResolutionError when resolving an unknown package", async () => {
    rootDir = await setupPlugins([
      {
        dirName: "workflow-sdk",
        packageName: "@opencx/workflow-sdk",
        manifest: { displayName: "OpenCX" },
      },
    ]);
    const resolver = new LocalPluginResolver({ rootDir });
    await expect(resolver.resolve("@not/real")).rejects.toBeInstanceOf(
      PluginResolutionError,
    );
  });

  it("reads README and types files listed in the manifest", async () => {
    rootDir = await setupPlugins([
      {
        dirName: "workflow-sdk",
        packageName: "@opencx/workflow-sdk",
        manifest: {
          displayName: "OpenCX",
          docs: { readme: "README.md", types: "dist/index.d.ts" },
        },
        extraFiles: {
          "README.md": "# OpenCX\n",
          "dist/index.d.ts": "export const x: number;\n",
        },
      },
    ]);
    const resolver = new LocalPluginResolver({ rootDir });
    const plugin = await resolver.resolve("@opencx/workflow-sdk");
    expect(await resolver.readReadme(plugin)).toContain("OpenCX");
    expect(await resolver.readTypes(plugin)).toContain("number");
  });

  it("lists all files except src/ and common tool dirs", async () => {
    rootDir = await setupPlugins([
      {
        dirName: "workflow-sdk",
        packageName: "@opencx/workflow-sdk",
        manifest: { displayName: "OpenCX" },
        extraFiles: {
          "README.md": "# hi",
          "dist/index.js": "module.exports = {};",
          "dist/index.d.ts": "export {};",
          "src/internal.ts": "export const internal = 1;",
        },
      },
    ]);
    const resolver = new LocalPluginResolver({ rootDir });
    const plugin = await resolver.resolve("@opencx/workflow-sdk");
    const files = await resolver.listPluginFiles(plugin);
    const paths = Object.keys(files).sort();
    expect(paths).toContain("package.json");
    expect(paths).toContain("README.md");
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/index.d.ts");
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
  });
});
