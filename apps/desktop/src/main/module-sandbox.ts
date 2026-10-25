import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessText, type CodeAccess } from "../shared/code-access.js";
import { startEgressProxy } from "./egress-proxy.js";
import { canonicalModuleAccess } from "./module-access.js";
import { linuxModuleCommand } from "./module-sandbox-linux.js";

/** How a confined module's process starts, and what to release after. */
export interface ModuleLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Trusted setup handles, consumed before the untrusted workload starts. */
  inheritedFds?: readonly number[];
  /** Release the parent's setup handles once spawn has duplicated them. */
  spawned?: () => void;
  close: () => Promise<void>;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Public OS runtime, never whole volumes or user-controlled tool prefixes. */
const PUBLIC_RUNTIME_READS = [
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
];
const PUBLIC_RUNTIME_FILES = [
  // Directory entries only; Bun needs a root descriptor to initialize.
  "/",
  "/dev/null",
  "/dev/random",
  "/dev/urandom",
  "/private/etc/hosts",
  "/private/etc/resolv.conf",
  "/private/etc/localtime",
  "/private/etc/ssl/cert.pem",
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
  listable = [],
}: {
  projectRoot: string;
  /** Beyond the project: Bun, the worker, scratch, declared reads. */
  readable: readonly string[];
  writable: readonly string[];
  proxyPort: number | null;
  /** Directory entries only: Bun resolves the worker without reading siblings. */
  listable?: readonly string[];
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
    "(deny file-read-data file-map-executable process-exec)",
    `(allow file-read-data file-map-executable process-exec ${subpaths([...PUBLIC_RUNTIME_READS.map(real), projectRoot, ...readable, ...writable])} ${[...PUBLIC_RUNTIME_FILES.map(real), ...listable].map((entry) => `(literal ${literal(entry)})`).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") ${subpaths(writable)})`,
    "(deny mach-lookup)",
    "(deny sysctl-read)",
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name "machdep.ptrauth_enabled") (sysctl-name-prefix "kern.os") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfiles") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.hostname") (sysctl-name "kern.usrstack64") (sysctl-name "kern.boottime") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))',
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(deny mach-priv-task-port)",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(deny appleevent-send)",
    "(deny signal)",
    "(allow signal (target self))",
  ].join("\n");
}

/**
 * Start a module's process confined to its declared access (ADR 0277):
 * a clean environment (Work's Bun on PATH, a home and temp folder of its
 * own, its proxy), its own loopback proxy when it declares hosts, and the
 * Seatbelt profile above or Linux namespaces and seccomp. A throwaway E2E
 * profile may explicitly opt out.
 */
export async function launchConfinedModule({
  executable,
  workerPath,
  modulePath,
  projectRoot,
  access,
  toolchain,
  scratchRoot,
  scope = "",
  platform = process.platform,
  unconfined = false,
  blocked,
  onRefused,
}: {
  executable: string;
  workerPath: string;
  modulePath: string;
  projectRoot: string;
  /** Canonical destinations already compared with the person's approval. */
  access: CodeAccess;
  /** Work's toolchain environment; only PATH and CATAMORPHIC_BUN are kept. */
  toolchain: Record<string, string>;
  /** Where modules keep their home and temp folders. */
  scratchRoot: string;
  /** Host identity: profiles and project identities never share private files. */
  scope?: string;
  platform?: NodeJS.Platform;
  /** A throwaway E2E profile on a platform without confinement. */
  unconfined?: boolean;
  blocked?: (host: string, port: number) => boolean;
  onRefused?: (address: string) => void;
}): Promise<ModuleLaunch> {
  if (!["darwin", "linux"].includes(platform) && !unconfined)
    throw new Error("Sidebar modules require macOS or Linux confinement.");
  const root = real(projectRoot);
  const canonical = canonicalModuleAccess({ access, projectRoot: root });
  if (accessText(canonical) !== accessText(access))
    throw new Error(
      "This module's access paths changed. Review its access before running it.",
    );
  const scratch = path.join(
    scratchRoot,
    createHash("sha256")
      .update(`${scope}\n${root}\n${modulePath}`)
      .digest("hex")
      .slice(0, 16),
  );
  const home = path.join(scratch, "home");
  const temp = path.join(scratch, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const networkDir =
    platform === "linux" && !unconfined && canonical.hosts?.length
      ? fs.mkdtempSync(path.join(os.tmpdir(), "work-module-network-"))
      : null;
  const proxySocket = networkDir
    ? path.join(networkDir, "proxy.sock")
    : undefined;
  const proxy = await (async () => {
    try {
      return canonical.hosts?.length
        ? await startEgressProxy({
            hosts: canonical.hosts,
            blocked,
            onRefused,
            socketPath: proxySocket,
          })
        : null;
    } catch (error) {
      if (networkDir) fs.rmSync(networkDir, { recursive: true, force: true });
      throw error;
    }
  })();
  const proxyUrl = proxy
    ? `http://127.0.0.1:${proxySocket ? 3128 : proxy.port}`
    : null;
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
    if (networkDir) fs.rmSync(networkDir, { recursive: true, force: true });
  };
  const bun = real(onPath(executable, env.PATH));
  if (unconfined)
    return { command: bun, args: [workerPath, modulePath], env, close };
  if (platform === "linux") {
    try {
      const launch = linuxModuleCommand({
        bun,
        workerPath,
        modulePath,
        projectRoot: root,
        readable: [bun, real(workerPath), ...(canonical.reads ?? [])],
        writable: [real(scratch), ...(canonical.writes ?? [])],
        proxySocket,
      });
      return {
        ...launch,
        env,
        spawned: launch.close,
        close: async () => {
          launch.close();
          await close();
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  const profile = moduleProfile({
    projectRoot: root,
    readable: [bun, real(workerPath), ...(canonical.reads ?? [])],
    writable: [real(scratch), ...(canonical.writes ?? [])],
    proxyPort: proxy?.port ?? null,
    listable: [real(path.dirname(workerPath))],
  });
  return {
    command: SANDBOX_EXEC,
    args: ["-p", profile, bun, workerPath, modulePath],
    env,
    close,
  };
}
