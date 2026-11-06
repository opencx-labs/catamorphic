import fs from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_PERSONAL_DIR,
  PROJECT_WORKSPACE_ROOT,
} from "@catamorphic/workflow/project-layout";

const PROFILE_ID = /^[A-Za-z0-9_-]+$/;

const isErrorCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** The profile's personal folder and its parents, outermost first. */
const personalChain = (profileId: string) => [
  PROJECT_WORKSPACE_ROOT,
  PROJECT_PERSONAL_DIR,
  `${PROJECT_PERSONAL_DIR}/${profileId}`,
];

/** Local discovery is scoped to the active desktop profile, never shared APIs. */
export async function listPersonalFiles({
  root,
  profileId,
}: {
  root: string;
  profileId: string;
}): Promise<Array<{ path: string }>> {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid profile");
  const directory = path.join(root, PROJECT_PERSONAL_DIR, profileId);
  for (const relative of personalChain(profileId)) {
    const entry = await fs
      .lstat(path.join(root, relative))
      .catch((error: unknown) => {
        if (isErrorCode(error, "ENOENT")) return null;
        throw error;
      });
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) return [];
  }
  const files: Array<{ path: string }> = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile())
        files.push({
          path: path.relative(root, target).split(path.sep).join("/"),
        });
    }
  };
  await walk(directory);
  return files;
}

/**
 * A new empty file in the profile's personal folder, named `Untitled` and
 * numbered past any that exist (`Untitled 2.md`, …). Returns its
 * project-relative path.
 */
export async function createPersonalFile({
  root,
  profileId,
  extension,
}: {
  root: string;
  profileId: string;
  extension: string;
}): Promise<string> {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid profile");
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error("Invalid extension");
  for (const relative of personalChain(profileId)) {
    const directory = path.join(root, relative);
    await fs.mkdir(directory).catch((error: unknown) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
    const entry = await fs.lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(`${relative} is not a folder`);
  }
  for (let number = 1; ; number++) {
    const relative = `${PROJECT_PERSONAL_DIR}/${profileId}/Untitled${
      number === 1 ? "" : ` ${number}`
    }.${extension}`;
    try {
      // "wx" never replaces a file, so a name taken meanwhile moves on.
      await fs.writeFile(path.join(root, relative), "", { flag: "wx" });
      return relative;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
  }
}
