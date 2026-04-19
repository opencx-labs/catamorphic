import url from "node:url";

export function isExecutedDirectly(importMetaUrl: string) {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  return url.fileURLToPath(importMetaUrl) === entryFile;
}
