import fs from "node:fs/promises";
import path from "node:path";

/** Runtime packages stage their actual built code and types without reading assets stripped by packagers. */
export async function buildPackagePayload({ root }: { root: string }) {
  const manifestText = await fs.readFile(
    path.join(root, "package.json"),
    "utf8",
  );
  const manifest: unknown = JSON.parse(manifestText);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    typeof manifest.name !== "string" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("A runtime package needs a name and version.");
  const exports =
    "exports" in manifest &&
    typeof manifest.exports === "object" &&
    manifest.exports !== null
      ? Object.fromEntries(
          Object.entries(manifest.exports).filter(
            ([key]) => key !== "./package-payload",
          ),
        )
      : undefined;
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      { ...manifest, ...(exports ? { exports } : {}) },
      null,
      2,
    ),
  };
  const directory = path.join(root, "dist");
  for (const entry of await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      !/\.(js|ts)$/.test(entry.name) ||
      /^package-payload\./.test(entry.name)
    )
      continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(root, file)] = await fs.readFile(file, "utf8");
  }
  if (!files["dist/index.js"] || !files["dist/index.d.ts"])
    throw new Error(
      `${manifest.name} must build JavaScript and declarations before its payload.`,
    );
  const payload = {
    packageName: manifest.name,
    version: manifest.version,
    files,
  };
  await fs.writeFile(
    path.join(directory, "package-payload.js"),
    `// Generated from this package's built exports.\nexport default ${JSON.stringify(payload)};\n`,
  );
  await fs.writeFile(
    path.join(directory, "package-payload.d.ts"),
    "declare const payload: { packageName: string; version: string; files: Record<string, string> };\nexport default payload;\n",
  );
  return payload;
}

if (import.meta.main) await buildPackagePayload({ root: process.cwd() });
