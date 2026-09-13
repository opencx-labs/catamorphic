import fs from "node:fs/promises";
import path from "node:path";

/** Local discovery is scoped to the active desktop profile, never shared APIs. */
export async function listPersonalFiles({
  root,
  profileId,
}: {
  root: string;
  profileId: string;
}): Promise<Array<{ path: string }>> {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new Error("Invalid profile");
  const directory = path.join(root, ".catamorphic", "personal", profileId);
  for (const relative of [
    ".catamorphic",
    ".catamorphic/personal",
    `.catamorphic/personal/${profileId}`,
  ]) {
    const entry = await fs
      .lstat(path.join(root, relative))
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
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
