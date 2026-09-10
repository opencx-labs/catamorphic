/** Rank literal path matches before compact subsequences, favoring the basename. */
export function fileSearchScore(filePath: string, query: string): number {
  const value = filePath.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const basename = value.slice(value.lastIndexOf("/") + 1);
  if (basename === needle) return 100;
  if (basename.startsWith(needle)) return 90;
  if (basename.includes(needle)) return 80;
  if (value.includes(needle)) return 70;
  const compact = needle.replaceAll(" ", "");
  let cursor = 0;
  let gaps = 0;
  for (const char of compact) {
    const next = value.indexOf(char, cursor);
    if (next < 0) return 0;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 30 + 20 / (gaps + 1);
}
