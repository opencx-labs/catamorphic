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

/**
 * PATH for the builder: the CLI's own folder and the usual tool folders
 * first, so Docker Desktop's credential helpers resolve. Relative entries
 * never reach it.
 */
export function imageBuilderEnvironment({
  command,
  env = process.env,
  knownDirectories = KNOWN_DIRECTORIES,
}: {
  command: string;
  env?: NodeJS.ProcessEnv;
  knownDirectories?: readonly string[];
}): NodeJS.ProcessEnv {
  const entries = [
    path.dirname(command),
    ...knownDirectories,
    ...(env.HOME ? [path.join(env.HOME, ".docker", "bin")] : []),
    ...(env.PATH ?? "").split(path.delimiter),
  ].filter((entry) => path.isAbsolute(entry));
  return { ...env, PATH: [...new Set(entries)].join(path.delimiter) };
}
