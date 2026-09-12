import { appScaffold } from "@catamorphic/core";
import { z } from "zod";

/** Installs the fetched registry source into this fixture's temporary app. */
export function reviewAppFiles(value: unknown): Record<string, string> {
  const pack = z
    .object({
      name: z.literal("code-review"),
      dependencies: z.array(z.string()),
      files: z.array(z.object({ path: z.string(), content: z.string() })),
    })
    .parse(value);
  const scaffold = appScaffold({ name: "review" });
  const packagePath = "apps/review/package.json";
  const configPath = "apps/review/vite.config.ts";
  const packageSource = scaffold[packagePath];
  const configSource = scaffold[configPath];
  if (!packageSource || !configSource)
    throw new Error("App scaffold is incomplete");
  const manifest = z
    .object({
      dependencies: z.record(z.string(), z.string()),
    })
    .passthrough()
    .parse(JSON.parse(packageSource));
  for (const dependency of pack.dependencies) {
    const separator = dependency.lastIndexOf("@");
    manifest.dependencies[dependency.slice(0, separator)] = dependency.slice(
      separator + 1,
    );
  }
  return {
    ...Object.fromEntries(
      pack.files.map((file) => [`apps/review/src/${file.path}`, file.content]),
    ),
    [packagePath]: JSON.stringify(manifest),
    [configPath]: `import { fileURLToPath } from "node:url";\n${configSource.replace(
      "resolve: { dedupe:",
      'resolve: { alias: [{ find: /^shiki$/, replacement: fileURLToPath(new URL("./src/components/catamorphic/review-highlighter.ts", import.meta.url)) }], dedupe:',
    )}`,
  };
}

/** Deterministic authoring fixture; compiled through the real app pipeline. */
export { default as reviewAppSource } from "./e2e-review-source.json";
