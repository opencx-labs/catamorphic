import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A grant directory is append-only. Only positive decimal filenames are
 * published revisions; staging files and directories are never candidates.
 */
export async function readConnectionGrant(input: {
  directory: string;
}): Promise<string> {
  const entries = await readdir(input.directory, { withFileTypes: true });
  const latest = entries.reduce<string | undefined>((current, entry) => {
    if (!entry.isFile() || !/^[1-9][0-9]*$/.test(entry.name)) return current;
    return current === undefined || BigInt(entry.name) > BigInt(current)
      ? entry.name
      : current;
  }, undefined);
  if (!latest) throw new Error("No published connection grant");
  return (await readFile(path.join(input.directory, latest), "utf8")).trim();
}

/** POSIX reader: its first argument is an append-only grant directory. */
export const CONNECTION_GRANT_READER =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
  'revision=$(for file in "$1"/*; do [ -f "$file" ] && printf \'%s\\n\' "${file##*/}"; done | sed -n "/^[1-9][0-9]*$/p" | LC_ALL=C sort -n | tail -n 1); [ -n "$revision" ] || exit 1; cat "$1/$revision"';

/** Native model helpers resolve their attempt's latest grant on each use. */
export const MODEL_GRANT_READER = `set -- "$WORK_MODEL_GRANT_DIRECTORY"; ${CONNECTION_GRANT_READER}`;
