/** Bulk snapshots are bounded; oversized projects fail instead of exhausting the host. */
export interface FileReadOptions {
  filter?: (path: string) => boolean;
  excludeNestedRepositories?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export async function readFileSnapshot({
  paths,
  read,
  options = {},
}: {
  paths: readonly string[];
  read: (path: string, maxBytes: number) => Promise<string>;
  options?: FileReadOptions;
}): Promise<Record<string, string>> {
  const selected = paths.filter((path) => options.filter?.(path) ?? true);
  const files: Record<string, string> = {};
  const maxFileBytes = options.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_SNAPSHOT_BYTES;
  for (const limit of [maxFileBytes, maxTotalBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Snapshot byte limits must be positive integers");
  }
  let total = 0;
  // A failed batch settles before returning, so it cannot leave background reads.
  for (let offset = 0; offset < selected.length; offset += 8) {
    const batch = await Promise.allSettled(
      selected.slice(offset, offset + 8).map(async (path) => {
        const content = await read(path, maxFileBytes);
        const bytes = Buffer.byteLength(content);
        if (bytes > maxFileBytes)
          throw new Error(
            `Project file '${path}' exceeds the ${maxFileBytes}-byte snapshot limit`,
          );
        total += bytes;
        if (total > maxTotalBytes)
          throw new Error(
            `Project snapshot exceeds the ${maxTotalBytes}-byte limit; narrow the source selection or exclude generated files`,
          );
        files[path] = content;
      }),
    );
    for (const result of batch)
      if (result.status === "rejected") throw result.reason;
  }
  return files;
}
