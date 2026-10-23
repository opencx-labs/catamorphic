import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodeAccess } from "../shared/code-access.js";
import { startEgressProxy } from "./egress-proxy.js";

/** How a confined module's process starts, and what to release after. */
export interface ModuleLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  close: () => Promise<void>;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Where a person's data lives, unreadable unless the module may read it. */
const PRIVATE_ROOTS = [
  "/Users",
  "/Volumes",
  "/private/var/folders",
  "/private/tmp",
];

function real(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** A bare command found on PATH, as the shell would run it. */
function onPath(command: string, searchPath: string | undefined): string {
  if (command.includes("/")) return command;
  for (const folder of (searchPath ?? "").split(path.delimiter)) {
    if (!folder) continue;
    const candidate = path.join(folder, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return command;
}

function fromHome(entry: string): string {
  return entry === "~" || entry.startsWith("~/")
    ? path.join(os.homedir(), entry.slice(2))
    : entry;
}

/** A Seatbelt string literal. */
function literal(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The Seatbelt profile a module runs under (ADR 0277). Network: only its
 * proxy's port. Files: the project, Work's Bun, the worker and the module's
 * own scratch folder are readable, and nothing else where people keep
 * data; writes reach the scratch folder and what the module declares. No
 * system services (so no opening addresses in a browser, no clipboard, no
 * keychain), no Apple events to other apps, no signals to other processes.
 */
export function moduleProfile({
  projectRoot,
  readable,
  writable,
  proxyPort,
}: {
  projectRoot: string;
  /** Beyond the project: Bun, the worker, scratch, declared reads. */
  readable: readonly string[];
  writable: readonly string[];
  proxyPort: number | null;
}): string {
  const subpaths = (paths: readonly string[]) =>
    paths.map((entry) => `(subpath ${literal(entry)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...(proxyPort === null
      ? []
      : [`(allow network-outbound (remote ip "localhost:${proxyPort}"))`]),
    `(deny file-read-data ${subpaths(PRIVATE_ROOTS)})`,
    `(allow file-read-data ${subpaths([projectRoot, ...readable, ...writable])})`,
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") ${subpaths(writable)})`,
    "(deny mach-lookup)",
    "(deny appleevent-send)",
    "(deny signal)",
    "(allow signal (target self))",
  ].join("\n");
}

/**
 * Start a module's process confined to its declared access (ADR 0277):
 * a clean environment (Work's Bun on PATH, a home and temp folder of its
 * own, its proxy), its own loopback proxy when it declares hosts, and the
 * Seatbelt profile above. Confinement is macOS's; elsewhere a module runs
 * only for a throwaway E2E profile, which may opt out.
 */
export async function launchConfinedModule({
  executable,
  workerPath,
  modulePath,
  projectRoot,
  access,
  toolchain,
  scratchRoot,
  platform = process.platform,
  unconfined = false,
  blocked,
  onRefused,
}: {
  executable: string;
  workerPath: string;
  modulePath: string;
  projectRoot: string;
  access: CodeAccess;
  /** Work's toolchain environment; only PATH and CATAMORPHIC_BUN are kept. */
  toolchain: Record<string, string>;
  /** Where modules keep their home and temp folders. */
  scratchRoot: string;
  platform?: NodeJS.Platform;
  /** A throwaway E2E profile on a platform without confinement. */
  unconfined?: boolean;
  blocked?: (host: string, port: number) => boolean;
  onRefused?: (address: string) => void;
}): Promise<ModuleLaunch> {
  if (platform !== "darwin" && !unconfined)
    throw new Error(
      "Sidebar modules run confined, which Work does on macOS only for now.",
    );
  const root = real(projectRoot);
  const scratch = path.join(
    scratchRoot,
    createHash("sha256")
      .update(`${root}\n${modulePath}`)
      .digest("hex")
      .slice(0, 16),
  );
  const home = path.join(scratch, "home");
  const temp = path.join(scratch, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const proxy = access.hosts?.length
    ? await startEgressProxy({ hosts: access.hosts, blocked, onRefused })
    : null;
  const proxyUrl = proxy ? `http://127.0.0.1:${proxy.port}` : null;
  const env: Record<string, string> = {
    // Where commands are found, nothing more: Work's own PATH holds no keys.
    PATH: toolchain.PATH ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: real(home),
    TMPDIR: real(temp),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(toolchain.CATAMORPHIC_BUN
      ? { CATAMORPHIC_BUN: toolchain.CATAMORPHIC_BUN }
      : {}),
    // Every address goes through the proxy, loopback ones included.
    ...(proxyUrl
      ? {
          HTTPS_PROXY: proxyUrl,
          HTTP_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          http_proxy: proxyUrl,
          NO_PROXY: "",
          no_proxy: "",
        }
      : {}),
  };
  const close = async () => {
    await proxy?.close();
  };
  const bun = real(onPath(executable, env.PATH));
  if (platform !== "darwin")
    return { command: bun, args: [workerPath, modulePath], env, close };
  const bunRoot =
    path.basename(path.dirname(bun)) === "bin"
      ? path.dirname(path.dirname(bun))
      : path.dirname(bun);
  const writes = (access.writes ?? []).map((entry) =>
    real(path.resolve(root, fromHome(entry))),
  );
  const profile = moduleProfile({
    projectRoot: root,
    readable: [
      bunRoot,
      real(path.dirname(workerPath)),
      ...(access.reads ?? []).map((entry) => real(fromHome(entry))),
    ],
    writable: [real(scratch), ...writes],
    proxyPort: proxy?.port ?? null,
  });
  return {
    command: SANDBOX_EXEC,
    args: ["-p", profile, bun, workerPath, modulePath],
    env,
    close,
  };
}
