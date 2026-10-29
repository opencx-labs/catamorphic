import fs from "node:fs";
import path from "node:path";
import { rewriteCrossItemImports } from "./imports.js";

interface RegistryFile {
  path: string;
  type: string;
  target?: string;
}

export interface RegistryItem {
  $schema?: string;
  name: string;
  type: string;
  description?: string;
  title?: string;
  docs?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  files: (RegistryFile & { content: string })[];
}

/** Resolve installable source against the registry's own release, without IO to npm. */
export function readRegistryItem({
  directory,
  version,
}: {
  directory: string;
  version: string;
}): RegistryItem {
  const item: Omit<RegistryItem, "files"> & { files: RegistryFile[] } =
    JSON.parse(
      fs.readFileSync(path.join(directory, "registry-item.json"), "utf8"),
    );
  const render = (content: string) => {
    if (/@catamorphic\/[\w-]+(?:@|"\s*:\s*")[~^]?\d/.test(content))
      throw new Error(
        `${item.name}: use {{CATAMORPHIC_VERSION}} instead of a hard-coded framework version`,
      );
    return content.replaceAll("{{CATAMORPHIC_VERSION}}", version);
  };
  const dependency = (specifier: string) => {
    if (!specifier.startsWith("@catamorphic/")) return specifier;
    if (!/^@catamorphic\/[\w-]+$/.test(specifier))
      throw new Error(
        `${item.name}: declare ${specifier} without a version; the registry pins its release`,
      );
    return `${specifier}@${version}`;
  };
  return {
    ...item,
    ...(item.docs === undefined ? {} : { docs: render(item.docs) }),
    ...(item.dependencies === undefined
      ? {}
      : { dependencies: item.dependencies.map(dependency) }),
    ...(item.devDependencies === undefined
      ? {}
      : { devDependencies: item.devDependencies.map(dependency) }),
    files: item.files.map((file) => ({
      ...file,
      content: render(
        rewriteCrossItemImports(
          fs.readFileSync(
            path.join(directory, path.basename(file.path)),
            "utf8",
          ),
        ),
      ),
    })),
  };
}
