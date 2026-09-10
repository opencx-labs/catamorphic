export interface ReviewLocation {
  label: string;
  line: number;
  side: "additions" | "deletions";
}
/** Real hunk locations, without inferring behavior from a filename. */
export function reviewLocations(patch: string): ReviewLocation[] {
  const locations: ReviewLocation[] = [];
  for (const row of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)$/.exec(
      row,
    );
    if (!match) continue;
    const deleted = match[4] === "0";
    const line = Math.max(1, Number(deleted ? match[1] : match[3]));
    locations.push({
      label: match[5]?.trim() || `Line ${line}`,
      line,
      side: deleted ? "deletions" : "additions",
    });
  }
  return locations;
}

/** Reconstruct the file headers omitted from GitHub's per-file patch field. */
export function pullRequestPatch(file: {
  path: string;
  previousPath?: string;
  status?: string;
  patch: string;
}): string {
  const oldPath = `a/${file.previousPath ?? file.path}`;
  const newPath = `b/${file.path}`;
  const quote = (value: string) =>
    /[\t\n\r"\\]/.test(value) ? JSON.stringify(value) : value;
  const rename = file.previousPath
    ? `rename from ${quote(file.previousPath)}\nrename to ${quote(file.path)}\n`
    : "";
  return `diff --git ${quote(oldPath)} ${quote(newPath)}\n${rename}--- ${file.status === "added" ? "/dev/null" : quote(oldPath)}\n+++ ${file.status === "removed" ? "/dev/null" : quote(newPath)}\n${file.patch}`;
}
