import fs from "node:fs";
import path from "node:path";

/**
 * Where Docker and Podman usually live on a desktop, beside PATH: an app
 * opened from the Finder starts with a short PATH that omits them.
 */
const KNOWN_DIRECTORIES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
];

/**
 * The Docker or Podman CLI this machine builds Environment images with
 * (ADR 0176), so a project's Dockerfile Environment also runs on This
 * machine. Undefined when neither is installed.
 */
export function findImageBuilderCommand({
  env = process.env,
  knownDirectories = KNOWN_DIRECTORIES,
}: {
  env?: NodeJS.ProcessEnv;
  knownDirectories?: readonly string[];
} = {}): string | undefined {
  const directories = [
    ...(env.PATH ?? "").split(path.delimiter),
    ...knownDirectories,
    ...(env.HOME ? [path.join(env.HOME, ".docker", "bin")] : []),
  ].filter(Boolean);
  for (const command of ["docker", "podman"])
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  return undefined;
}
