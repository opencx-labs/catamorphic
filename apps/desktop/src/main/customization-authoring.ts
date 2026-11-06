import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const assetsSchema = z.object({
  version: z.string(),
  reference: z.string(),
  worker: z.string(),
  tool: z.string(),
  triggerTypes: z.string(),
  packages: z.array(
    z.object({
      packageName: z.string(),
      version: z.string(),
      files: z.record(z.string(), z.string()),
    }),
  ),
});

/** Materialize immutable host build assets; no user code or dependency install runs here. */
export function customizationAuthoring({
  cacheDirectory,
  assetsFile = path.join(import.meta.dirname, "authoring-assets.json"),
}: {
  cacheDirectory: string;
  assetsFile?: string;
}) {
  const raw = fs.readFileSync(assetsFile, "utf8");
  const assets = assetsSchema.parse(JSON.parse(raw));
  const revision = createHash("sha256").update(raw).digest("hex");
  const directory = path.join(cacheDirectory, revision);
  if (!fs.existsSync(path.join(directory, "complete"))) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(cacheDirectory, ".build-"));
    try {
      for (const pkg of assets.packages) {
        if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(pkg.packageName))
          throw new Error("Invalid authoring package.");
        for (const [relative, contents] of Object.entries(pkg.files)) {
          if (
            path.isAbsolute(relative) ||
            relative.split(/[\\/]/).includes("..")
          )
            throw new Error("Invalid authoring asset path.");
          const target = path.join(
            temporary,
            "node_modules",
            pkg.packageName,
            relative,
          );
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, contents);
        }
      }
      fs.writeFileSync(
        path.join(temporary, "customization-tool.mjs"),
        assets.tool,
      );
      fs.writeFileSync(
        path.join(temporary, "source-worker.mjs"),
        assets.worker,
      );
      fs.writeFileSync(path.join(temporary, "reference.md"), assets.reference);
      fs.writeFileSync(
        path.join(temporary, "work-triggers.d.ts"),
        assets.triggerTypes,
      );
      fs.writeFileSync(path.join(temporary, "complete"), revision);
      if (!fs.existsSync(directory)) fs.renameSync(temporary, directory);
    } finally {
      if (fs.existsSync(temporary))
        fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return {
    version: assets.version,
    revision,
    sdkRoot: directory,
    types: path.join(
      directory,
      "node_modules/@catamorphic/work-customization/dist/index.d.ts",
    ),
    reference: path.join(directory, "reference.md"),
    tool: path.join(directory, "customization-tool.mjs"),
    worker: path.join(directory, "source-worker.mjs"),
    triggerTypes: path.join(directory, "work-triggers.d.ts"),
    commands: {
      check: ["bun", path.join(directory, "customization-tool.mjs"), "check"],
      preview: [
        "bun",
        path.join(directory, "customization-tool.mjs"),
        "preview",
      ],
    },
  };
}
