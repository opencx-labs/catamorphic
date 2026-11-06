// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRegistry } from "../scripts/build.js";
import { type RegistryItem, readRegistryItem } from "../scripts/item.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-release-"));
  directories.push(root);
  const directory = path.join(root, "src", "pull-request-reviews");
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.cp(
    path.join(import.meta.dirname, "pull-request-reviews"),
    directory,
    {
      recursive: true,
    },
  );
  return { root, directory };
}

describe("registry release versions", () => {
  it("rebuilds the real recipe for a preview and stable release without editing its source", async () => {
    const { root, directory } = await fixture();
    const original = await fs.readFile(
      path.join(directory, "SKILL.md"),
      "utf8",
    );
    for (const version of ["0.1.0-alpha.999", "1.2.3"]) {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ version }),
      );
      await buildRegistry(root);
      const item: RegistryItem = JSON.parse(
        await fs.readFile(
          path.join(root, "dist", "r", "pull-request-reviews.json"),
          "utf8",
        ),
      );
      const catalog: RegistryItem[] = JSON.parse(
        await fs.readFile(path.join(root, "dist", "catalog.json"), "utf8"),
      );
      expect(catalog).toEqual([item]);
      expect(item.dependencies).toEqual([
        `@catamorphic/server-sdk@${version}`,
        "pg@8.23.1",
      ]);
      expect(item.devDependencies).toEqual(["@types/pg@8.23.1"]);
      const skill = item.files.find((file) => file.path.endsWith("SKILL.md"));
      expect(skill?.content).toContain(
        `"@catamorphic/server-sdk": "${version}"`,
      );
      expect(skill?.content).toContain(
        `"@catamorphic/work-server": "${version}"`,
      );
      expect(JSON.stringify(item)).not.toContain("{{CATAMORPHIC_VERSION}}");
      expect(readRegistryItem({ directory, version })).toEqual(item);
    }
    expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toBe(
      original,
    );
  });

  it("pins framework development dependencies and docs while preserving third-party versions", async () => {
    const { directory } = await fixture();
    const filename = path.join(directory, "registry-item.json");
    const item: RegistryItem = JSON.parse(await fs.readFile(filename, "utf8"));
    item.devDependencies = ["@catamorphic/workflow", "typescript@^6"];
    item.docs = "bun add @catamorphic/server-sdk@{{CATAMORPHIC_VERSION}}";
    await fs.writeFile(filename, JSON.stringify(item));
    const resolved = readRegistryItem({ directory, version: "2.0.0" });
    expect(resolved.devDependencies).toEqual([
      "@catamorphic/workflow@2.0.0",
      "typescript@^6",
    ]);
    expect(resolved.docs).toBe("bun add @catamorphic/server-sdk@2.0.0");
  });

  it("rejects independently pinned framework dependencies", async () => {
    const { directory } = await fixture();
    const filename = path.join(directory, "registry-item.json");
    const item: RegistryItem = JSON.parse(await fs.readFile(filename, "utf8"));
    item.dependencies = ["@catamorphic/server-sdk@0.1.0-alpha.31"];
    await fs.writeFile(filename, JSON.stringify(item));
    expect(() => readRegistryItem({ directory, version: "2.0.0" })).toThrow(
      "without a version",
    );
  });

  it("rejects stale framework pins in installed files and usage notes", async () => {
    const { directory } = await fixture();
    await fs.appendFile(
      path.join(directory, "SKILL.md"),
      '\n"@catamorphic/work-server": "0.1.0-alpha.31"\n',
    );
    expect(() => readRegistryItem({ directory, version: "2.0.0" })).toThrow(
      "hard-coded framework version",
    );
    await fs.writeFile(path.join(directory, "SKILL.md"), "Unversioned source");
    const filename = path.join(directory, "registry-item.json");
    const item: RegistryItem = JSON.parse(await fs.readFile(filename, "utf8"));
    item.docs = "bun add @catamorphic/server-sdk@0.1.0-alpha.31";
    await fs.writeFile(filename, JSON.stringify(item));
    expect(() => readRegistryItem({ directory, version: "2.0.0" })).toThrow(
      "hard-coded framework version",
    );
  });
});
