import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import protocolPayload from "@catamorphic/agent-protocol/package-payload";
import appPayload from "@catamorphic/app/package-payload";
import { renderTriggerTypesModule } from "@catamorphic/core";
import sdkPayload from "@catamorphic/work-customization/package-payload";
import workflowPayload from "@catamorphic/workflow/package-payload";
import { build } from "../src/main/bun-build.js";
import { DESKTOP_TRIGGER_KINDS } from "../src/main/server/trigger-kinds.js";

/** Ship exact checked types, tools and worker as ordinary build assets. */
export async function buildAuthoringAssets({
  desktopRoot,
}: {
  desktopRoot: string;
}) {
  const require = createRequire(import.meta.url);
  const packages = [protocolPayload, appPayload, sdkPayload, workflowPayload];
  for (const name of [
    "@types/node",
    "@types/bun",
    "bun-types",
    "undici-types",
  ]) {
    const manifestPath =
      name === "bun-types"
        ? createRequire(require.resolve("@types/bun/package.json")).resolve(
            `${name}/package.json`,
          )
        : name === "undici-types"
          ? createRequire(require.resolve("@types/node/package.json")).resolve(
              `${name}/package.json`,
            )
          : require.resolve(`${name}/package.json`);
    const root = path.dirname(manifestPath);
    const manifest: { version: string } = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    );
    const files: Record<string, string> = {};
    for (const entry of await fs.readdir(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        !(
          entry.name === "package.json" ||
          /\.d\.(?:ts|mts|cts)$/.test(entry.name)
        )
      )
        continue;
      const absolute = path.join(entry.parentPath, entry.name);
      files[path.relative(root, absolute)] = await fs.readFile(
        absolute,
        "utf8",
      );
    }
    packages.push({ packageName: name, version: manifest.version, files });
  }
  const output = path.join(desktopRoot, "out/main");
  await fs.mkdir(output, { recursive: true });
  const compile = async (entry: string, filename: string) => {
    const result = await build({
      entrypoints: [path.join(desktopRoot, "src/main", entry)],
      target: "bun",
      packages: "bundle",
      external: ["electron"],
    });
    if (!result.success || !result.outputs[0])
      throw new AggregateError(result.logs, `Could not build ${entry}`);
    const source = await result.outputs[0].text();
    await fs.writeFile(path.join(output, filename), source);
    return source;
  };
  const worker = await compile(
    "sidebar-source-worker.ts",
    "sidebar-source-worker.js",
  );
  const tool = await compile("customization-tool.ts", "customization-tool.mjs");
  const reference = await fs.readFile(
    path.join(desktopRoot, "docs/customization-reference.md"),
    "utf8",
  );
  const triggerTypes = renderTriggerTypesModule({
    kinds: DESKTOP_TRIGGER_KINDS,
  });
  await fs.writeFile(
    path.join(output, "authoring-assets.json"),
    JSON.stringify({
      version: sdkPayload.version,
      packages,
      worker,
      tool,
      reference,
      triggerTypes,
    }),
  );
}

if (import.meta.main)
  await buildAuthoringAssets({
    desktopRoot: path.resolve(import.meta.dirname, ".."),
  });
