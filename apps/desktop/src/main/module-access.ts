import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CodeAccess,
  describeAccess,
  parseCodeAccess,
} from "../shared/code-access.js";

/** A module's declared reach, and the file that declares it. */
export interface ModuleAccess {
  /** Canonical filesystem destinations, shared by approval and enforcement. */
  access: CodeAccess;
  /** The package.json naming it; null when the module has none. */
  file: string | null;
}

/** Resolve existing ancestors too, so a new file cannot hide a symlink. */
function canonicalPath(file: string): string {
  let current = path.resolve(file);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...suffix);
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      )
        throw cause;
      // A dangling symlink is not a new file beneath a safe ancestor.
      if (fs.lstatSync(current, { throwIfNoEntry: false }))
        throw new Error(`Cannot resolve the access path ${file}.`);
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The exact destinations that are compared, signed, and sandboxed. */
export function canonicalModuleAccess({
  access,
  projectRoot,
}: {
  access: CodeAccess;
  projectRoot: string;
}): CodeAccess {
  const checked = parseCodeAccess(access, "module access");
  const paths = (entries: readonly string[]) =>
    [
      ...new Set(
        entries.map((entry) =>
          canonicalPath(
            path.resolve(
              projectRoot,
              entry === "~" || entry.startsWith("~/")
                ? path.join(os.homedir(), entry.slice(2))
                : entry,
            ),
          ),
        ),
      ),
    ].sort();
  return {
    ...checked,
    ...(checked.reads ? { reads: paths(checked.reads) } : {}),
    ...(checked.writes ? { writes: paths(checked.writes) } : {}),
  };
}

/** Keep project paths readable while the approval binds their real targets. */
export function describeModuleAccess({
  access,
  projectRoot,
}: {
  access: CodeAccess;
  projectRoot: string;
}): string[] {
  const root = canonicalPath(projectRoot);
  const display = (file: string) => {
    const relative = path.relative(root, file);
    return relative === "" ? "." : insideProject(root, file) ? relative : file;
  };
  return describeAccess({
    ...access,
    ...(access.reads ? { reads: access.reads.map(display) } : {}),
    ...(access.writes ? { writes: access.writes.map(display) } : {}),
  });
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
      return {
        access: canonicalModuleAccess({
          access: parseCodeAccess(declared, where),
          projectRoot,
        }),
        file,
      };
    }
    if (path.resolve(folder) === path.resolve(projectRoot))
      return { access: {}, file: null };
    folder = path.dirname(folder);
  }
}
