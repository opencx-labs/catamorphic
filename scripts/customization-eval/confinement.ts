import { accessSync, constants, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function literal(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Outer read boundary: Codex's workspace-write policy alone permits host reads. */
export function evalSeatbeltProfile(input: {
  project: string;
  profile: string;
  auth: string;
  executables: readonly string[];
}): string {
  const readable = [
    "/System/Library",
    "/System/Cryptexes/OS",
    "/usr/lib",
    "/usr/libexec",
    "/usr/bin",
    "/usr/sbin",
    "/usr/share",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/Library/Developer/CommandLineTools",
    "/private/var/db/dyld",
    "/private/var/db/timezone",
    "/private/etc",
    input.project,
    input.profile,
    input.auth,
  ];
  const subpaths = (paths: readonly string[]) =>
    paths.map((file) => `(subpath ${literal(file)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-read-data file-map-executable)",
    `(allow file-read-data file-map-executable ${subpaths(readable)} ${["/", "/dev/null", "/dev/random", "/dev/urandom", ...input.executables].map((file) => `(literal ${literal(file)})`).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") ${subpaths([input.project, input.profile, input.auth])})`,
    "(deny appleevent-send)",
  ].join("\n");
}

export async function confinedAgentCommand(input: {
  command: string;
  project: string;
  profile: string;
  auth: string;
  bun: string;
}): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error(
      "Native harness eval read isolation currently requires macOS Seatbelt. Linux container execution is not implemented by this runner.",
    );
  const executable = input.command.includes("/")
    ? realpathSync(input.command)
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((folder) => path.join(folder, input.command))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
  if (!executable)
    throw new Error(`Executable ${input.command} is not on PATH`);
  const tools = path.join(input.profile, "tools");
  await mkdir(tools, { recursive: true });
  const profile = path.join(tools, "agent.sb");
  await writeFile(
    profile,
    evalSeatbeltProfile({
      ...input,
      executables: [realpathSync(executable), realpathSync(input.bun)],
    }),
  );
  const command = path.join(tools, "agent");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    command,
    `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(profile)} ${quote(executable)} "$@"\n`,
  );
  await chmod(command, 0o700);
  return command;
}
