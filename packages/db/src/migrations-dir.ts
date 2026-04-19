import path from "node:path";
import url from "node:url";

export function getMigrationsDir() {
  const currentFilePath = url.fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "../migrations");
}
