import fs from "node:fs";
import path from "node:path";
import { type CodeAccess, parseCodeAccess } from "../shared/code-access.js";

/** A module's declared reach, and the file that declares it. */
export interface ModuleAccess {
  access: CodeAccess;
  /** The package.json naming it; null when the module has none. */
  file: string | null;
}

/** The module is a file of the project, never outside it. */
export function insideProject(projectRoot: string, file: string): boolean {
  const relative = path.relative(projectRoot, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * What a module may reach (ADR 0277): `catamorphic.access` in the nearest
 * package.json from its folder up to the project root, so modules that
 * need different reach live in folders of their own, as apps do. A module
 * with no declaration reads the project and reaches nothing else. Throws
 * what to fix.
 */
export function readModuleAccess({
  modulePath,
  projectRoot,
}: {
  modulePath: string;
  projectRoot: string;
}): ModuleAccess {
  if (!insideProject(projectRoot, modulePath))
    throw new Error(
      `${modulePath} is outside the project: a module is a file in it.`,
    );
  let folder = path.dirname(modulePath);
  for (;;) {
    const file = path.join(folder, "package.json");
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // No package here; look further up.
    }
    if (text !== null) {
      const where = path.relative(projectRoot, file) || "package.json";
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error(`${where} is not valid JSON.`);
      }
      const catamorphic =
        typeof manifest === "object" && manifest !== null
          ? Reflect.get(manifest, "catamorphic")
          : undefined;
      const declared =
        typeof catamorphic === "object" && catamorphic !== null
          ? Reflect.get(catamorphic, "access")
          : undefined;
      return { access: parseCodeAccess(declared, where), file };
    }
    if (path.resolve(folder) === path.resolve(projectRoot))
      return { access: {}, file: null };
    folder = path.dirname(folder);
  }
}
