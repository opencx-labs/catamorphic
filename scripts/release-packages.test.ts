import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NPM_REGISTRY,
  npmReleaseTag,
  packReleasePackages,
  publicationOrder,
  publicationPlan,
  registeredPackage,
  setReleaseVersion,
  verifyPackedPackage,
  verifyReleasePackages,
  workspacePackages,
} from "./release-packages.js";

const version = "0.1.0-alpha.30";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("reads current publication metadata instead of a cached install snapshot", async () => {
  const published = {
    versions: {
      [version]: { dist: { integrity: "sha512-published" } },
    },
    "dist-tags": { alpha: version },
  };
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(published));

  expect(await registeredPackage("@catamorphic/workflow")).toEqual(published);
  expect(fetch).toHaveBeenCalledWith(
    `${NPM_REGISTRY}/@catamorphic%2fworkflow?write=true`,
  );
});

function fixture() {
  const rootPath = mkdtempSync(path.join(tmpdir(), "npm-release-test-"));
  directories.push(rootPath);
  const write = (filename: string, content: string) => {
    mkdirSync(path.dirname(path.join(rootPath, filename)), { recursive: true });
    writeFileSync(path.join(rootPath, filename), content);
  };
  const library = (
    name: string,
    dependencies: Record<string, string> = {},
  ) => ({
    name: `@catamorphic/${name}`,
    version,
    type: "module",
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/opencx-labs/catamorphic.git",
      directory: `packages/${name}`,
    },
    publishConfig: { registry: NPM_REGISTRY, access: "public" },
    exports: {
      ".": {
        bun: "./src/index.ts",
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    },
    dependencies,
    files: [
      "src",
      "dist",
      "LICENSE.txt",
      "!**/*.test.*",
      "!**/__tests__/**",
      "!**/fixtures/**",
    ],
  });
  write(
    "package.json",
    JSON.stringify({ private: true, workspaces: ["packages/*", "apps/*"] }),
  );
  write("LICENSE", "Apache License, Version 2.0\n");
  write("NOTICE", "Catamorphic attribution\n");
  write(
    "apps/desktop/package.json",
    JSON.stringify({ name: "desktop", private: true, version }),
  );
  write(
    "apps/server/package.json",
    JSON.stringify({ name: "server", private: true, version }),
  );
  for (const name of ["workflow", "app"]) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify(
        library(
          name,
          name === "app" ? { "@catamorphic/workflow": "workspace:*" } : {},
        ),
      ),
    );
    write(`packages/${name}/src/index.ts`, "export const value = 1;\n");
    write(`packages/${name}/dist/index.js`, "export const value = 1;\n");
    write(
      `packages/${name}/dist/index.d.ts`,
      "export declare const value: number;\n",
    );
    write(`packages/${name}/src/example.test.ts`, "not for publication\n");
    write(
      `packages/${name}/dist/__tests__/fixture.d.ts`,
      "not for publication\n",
    );
    write(`packages/${name}/src/fixtures/data.txt`, "not for publication\n");
  }
  return { rootPath, write, library };
}

describe("one release version", () => {
  it("updates every library and private app without requiring Git", () => {
    const { rootPath } = fixture();
    setReleaseVersion({ rootPath, version: "0.1.0-alpha.31" });
    expect(
      workspacePackages(rootPath).map((pkg) => pkg.manifest.version),
    ).toEqual(Array(4).fill("0.1.0-alpha.31"));
    expect(verifyReleasePackages({ rootPath }).version).toBe("0.1.0-alpha.31");
    expect(() =>
      setReleaseVersion({ rootPath, version: "0.1.0-beta.1" }),
    ).toThrow("alpha");
  });

  it("rejects a release tag or workspace whose version drifted", () => {
    const { rootPath, write, library } = fixture();
    expect(() =>
      verifyReleasePackages({ rootPath, version: "0.1.0-alpha.31" }),
    ).toThrow("does not match");
    write(
      "packages/app/package.json",
      JSON.stringify({ ...library("app"), version: "0.0.4" }),
    );
    expect(() => verifyReleasePackages({ rootPath })).toThrow(
      "@catamorphic/app is 0.0.4",
    );
  });

  it("cannot ship a library that still depends on a private package", () => {
    const { rootPath, write, library } = fixture();
    write(
      "packages/app/package.json",
      JSON.stringify(library("app", { "@catamorphic/missing": "workspace:*" })),
    );
    expect(() => verifyReleasePackages({ rootPath })).toThrow(
      "unpublished @catamorphic/missing",
    );
    write(
      "packages/app/package.json",
      JSON.stringify({ ...library("app"), private: true }),
    );
    expect(() => verifyReleasePackages({ rootPath })).toThrow(
      "exports a library but is private",
    );
  });

  it("keeps deployable applications private but synchronized", () => {
    const { rootPath, write } = fixture();
    write(
      "packages/bridge/package.json",
      JSON.stringify({ name: "@catamorphic/bridge", private: true, version }),
    );
    expect(verifyReleasePackages({ rootPath }).packages).toHaveLength(2);
    expect(workspacePackages(rootPath)).toHaveLength(5);
  });

  it("maps previews to alpha and stable versions to latest", () => {
    expect(npmReleaseTag(version)).toBe("alpha");
    expect(npmReleaseTag("1.0.0")).toBe("latest");
  });
});

describe("publication dependency graph", () => {
  it("publishes dependencies first while tolerating development cycles", () => {
    const a = {
      directory: "a",
      manifest: { name: "a", version, dependencies: { b: "workspace:*" } },
    };
    const b = {
      directory: "b",
      manifest: { name: "b", version, devDependencies: { a: "workspace:*" } },
    };
    expect(publicationOrder([a, b]).map((pkg) => pkg.manifest.name)).toEqual([
      "b",
      "a",
    ]);
    expect(() =>
      publicationOrder([
        a,
        {
          ...b,
          manifest: { ...b.manifest, dependencies: { a: "workspace:*" } },
        },
      ]),
    ).toThrow("Runtime dependency cycle");
  });
});

describe("public tarballs", () => {
  it("packs installable entries, exact internal versions, and a license while excluding tests", () => {
    const { rootPath } = fixture();
    const outputPath = path.join(rootPath, "artifacts");
    const inventory = packReleasePackages({ rootPath, outputPath });
    expect(inventory.version).toBe(version);
    expect(inventory.packages.map((pkg) => pkg.name)).toEqual([
      "@catamorphic/workflow",
      "@catamorphic/app",
    ]);
    const app = inventory.packages.find(
      (pkg) => pkg.name === "@catamorphic/app",
    );
    if (!app) throw new Error("Missing app artifact");
    const archive = path.join(outputPath, app.filename);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    expect(manifest.dependencies["@catamorphic/workflow"]).toBe(version);
    expect(manifest.exports["."].bun).toBe("./src/index.ts");
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(files).toContain("package/LICENSE.txt");
    expect(files).toContain("package/src/index.ts");
    expect(files).toContain("package/dist/index.js");
    expect(files).not.toMatch(/\.test\.|__tests__|fixtures/);
    expect(() =>
      readFileSync(path.join(rootPath, "packages/app/LICENSE.txt")),
    ).toThrow();
    expect(
      JSON.parse(
        readFileSync(path.join(rootPath, "packages/app/package.json"), "utf8"),
      ).dependencies["@catamorphic/workflow"],
    ).toBe("workspace:*");
  });

  it("rejects missing exports, missing migrations, and leaked local dependencies", () => {
    const manifest = {
      name: "@catamorphic/example",
      version,
      exports: { ".": "./dist/index.js" },
    };
    const files = ["dist/index.js", "LICENSE.txt"];
    const verify = (change: Partial<typeof manifest>, archiveFiles = files) =>
      verifyPackedPackage({
        manifest: { ...manifest, ...change },
        files: archiveFiles,
        expected: { ...manifest, ...change },
      });
    expect(() => verify({}, ["LICENSE.txt"])).toThrow("exported file");
    expect(() => verify({ name: "@catamorphic/db" })).toThrow("migrations");
    expect(() => verify({ name: "@catamorphic/runner-bundle" })).toThrow(
      "runner",
    );
    expect(() => verify({}, [...files, "src/.env"])).toThrow(
      "unexpected archive file",
    );
    expect(() =>
      verifyPackedPackage({
        manifest: {
          ...manifest,
          dependencies: { "@catamorphic/core": "workspace:*" },
        },
        files,
        expected: manifest,
      }),
    ).toThrow("still uses workspace:");
  });

  it("ships only the replay recordings exposed by public testing helpers", () => {
    for (const [name, file] of [
      ["@catamorphic/codex", "fixtures/replay/simple-reply.json"],
      ["@catamorphic/claude-code", "src/testing/fixtures/simple-reply.json"],
    ]) {
      if (!name || !file) throw new Error("Missing replay case");
      expect(() =>
        verifyPackedPackage({
          manifest: { name, version },
          files: ["LICENSE.txt", file],
          expected: { name, version },
        }),
      ).not.toThrow();
      expect(() =>
        verifyPackedPackage({
          manifest: { name, version },
          files: ["LICENSE.txt", "fixtures/private/data.json"],
          expected: { name, version },
        }),
      ).toThrow("unexpected archive file");
    }
  });
});

describe("recovering partial npm publication", () => {
  const a = {
    name: "@catamorphic/a",
    version,
    filename: "a.tgz",
    integrity: "sha512-a",
  };
  const b = {
    name: "@catamorphic/b",
    version,
    filename: "b.tgz",
    integrity: "sha512-b",
  };
  it("skips identical immutable versions and publishes only missing packages", () => {
    expect(
      publicationPlan({
        packages: [a, b],
        registered: [
          { versions: { [version]: { dist: { integrity: a.integrity } } } },
          {},
        ],
      }),
    ).toEqual([b]);
  });
  it("checks the entire release before writing when an existing version differs", () => {
    expect(() =>
      publicationPlan({
        packages: [a, b],
        registered: [
          {},
          { versions: { [version]: { dist: { integrity: "sha512-other" } } } },
        ],
      }),
    ).toThrow("exists with different content");
    expect(() =>
      publicationPlan({ packages: [a, b], registered: [{}] }),
    ).toThrow("Missing npm lookup");
  });

  it("rejects an older alpha or stable release before any package can publish", () => {
    for (const [candidate, current] of [
      [version, "0.1.0-alpha.31"],
      ["1.0.0", "1.0.1"],
      ["0.1.0-alpha.9", "0.1.0-alpha.10"],
    ]) {
      if (!candidate || !current) throw new Error("Missing channel case");
      expect(() =>
        publicationPlan({
          packages: [
            { ...a, version: candidate },
            { ...b, version: candidate },
          ],
          registered: [
            {},
            { "dist-tags": { [npmReleaseTag(candidate)]: current } },
          ],
        }),
      ).toThrow("refusing to move");
    }
  });

  it("allows forward channels and npm's initial placeholder", () => {
    for (const [candidate, current] of [
      [version, "0.1.0-alpha.9"],
      ["1.0.0", "0.0.0-stage"],
      ["1.0.0", "0.9.0"],
    ]) {
      if (!candidate || !current) throw new Error("Missing channel case");
      expect(
        publicationPlan({
          packages: [{ ...a, version: candidate }],
          registered: [
            { "dist-tags": { [npmReleaseTag(candidate)]: current } },
          ],
        }),
      ).toHaveLength(1);
    }
  });
});

it("keeps manual release runs read-only and publishes after the desktop using OIDC", () => {
  const rootPath = path.resolve(import.meta.dirname, "..");
  const workflow: {
    concurrency: {
      group: string;
      "cancel-in-progress": boolean;
      queue: string;
    };
    jobs: Record<
      string,
      {
        needs?: string | string[];
        if?: string;
        environment?: string;
        permissions?: Record<string, string>;
        steps: Array<{
          uses?: string;
          run?: string;
          with?: Record<string, string>;
        }>;
      }
    >;
  } = JSON.parse(
    execFileSync(
      "bun",
      [
        "-e",
        'process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/desktop-prerelease.yml").text())))',
      ],
      { cwd: rootPath, encoding: "utf8" },
    ),
  );
  const prepare = workflow.jobs["prepare-npm"];
  const desktop = workflow.jobs["build-macos"];
  const publish = workflow.jobs["publish-npm"];
  expect(workflow.concurrency.group).not.toContain("github.ref");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.concurrency.queue).toBe("max");
  expect(desktop?.needs).toBe("prepare-npm");
  expect(publish?.needs).toContain("build-macos");
  expect(publish?.if).toContain("github.event_name == 'push'");
  expect(publish?.if).toContain("github.ref_type == 'tag'");
  expect(publish?.permissions?.["id-token"]).toBe("write");
  expect(publish?.environment).toBeUndefined();
  expect(prepare?.steps.map((step) => step.run).join("\n")).toContain(
    "release:smoke",
  );
  expect(prepare?.steps.map((step) => step.run).join("\n")).toContain(
    "preflight --directory",
  );
  expect(prepare?.steps.map((step) => step.run).join("\n")).not.toContain(
    "publish --directory",
  );
  const upload = prepare?.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  const download = publish?.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  expect(upload?.with?.name).toContain("npm-packages-");
  expect(download?.with?.name).toContain("needs.prepare-npm.outputs.version");
});
