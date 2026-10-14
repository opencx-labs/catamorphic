import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleConfigs, externalsOf, splits } from "./build-package.js";

const root = path.resolve(import.meta.dirname, "..");

describe("package bundles", () => {
  it("keep declared dependencies and their subpaths as imports", () => {
    const manifest = {
      name: "@catamorphic/example",
      bundle: { entry: ["src/index.ts"], external: ["react"] },
      dependencies: { kysely: "^0.29.0" },
      peerDependencies: { "react-dom": "^19.0.0" },
      optionalDependencies: { "@catamorphic/otel": "workspace:*" },
    };
    expect(externalsOf(manifest, manifest.bundle).sort()).toEqual(
      [
        "@catamorphic/otel",
        "@catamorphic/otel/*",
        "kysely",
        "kysely/*",
        "react",
        "react-dom",
        "react-dom/*",
        "react/*",
      ].sort(),
    );
  });

  it("split only builds whose entries can share code, unless told", () => {
    expect(splits({ entry: ["src/index.ts"] })).toBe(false);
    expect(splits({ entry: ["src/index.ts", "src/testing/index.ts"] })).toBe(
      true,
    );
    expect(
      splits({ entry: ["src/index.ts", "src/cli.ts"], splitting: false }),
    ).toBe(false);
  });

  it("refuse a missing bundle and entries outside src/", () => {
    expect(() => bundleConfigs({ name: "x" })).toThrow('has no "bundle"');
    expect(() =>
      bundleConfigs({ name: "x", bundle: { entry: ["scripts/a.ts"] } }),
    ).toThrow("is not a file under src/");
    expect(() => bundleConfigs({ name: "x", bundle: { entry: [] } })).toThrow(
      "lists source files",
    );
  });

  it("are declared by every package that builds with them", () => {
    for (const name of readdirSync(path.join(root, "packages"))) {
      const file = path.join(root, "packages", name, "package.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      const build: string | undefined = manifest.scripts?.build;
      if (!build?.includes("scripts/build-package.ts")) continue;
      expect(() => bundleConfigs(manifest), name).not.toThrow();
    }
  });
});
