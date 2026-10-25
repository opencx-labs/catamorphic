import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const packageRequire = createRequire(import.meta.url);
let checkedBubblewrap = false;

/** No shell lookup in a project-controlled PATH. Dependencies are OS tools. */
function systemTool(name: string): string {
  for (const folder of ["/usr/bin", "/bin"]) {
    const file = path.join(folder, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  throw new Error(
    `Confined modules on Linux require ${name}. Install bubblewrap and socat with your system package manager.`,
  );
}

/** Packaged, pinned helper; never a global npm install or project executable. */
function seccompHelper(): string {
  if (!["arm64", "x64"].includes(process.arch))
    throw new Error(
      "Confined modules on Linux require an arm64 or x64 system.",
    );
  const packageRoot = path.dirname(
    packageRequire.resolve("@anthropic-ai/sandbox-runtime/package.json"),
  );
  // Electron cannot exec an ELF inside app.asar. electron-builder unpacks it.
  const file = path
    .join(packageRoot, "vendor", "seccomp", process.arch, "apply-seccomp")
    .replace(/\.asar([/\\])/, ".asar.unpacked$1");
  fs.accessSync(file, fs.constants.X_OK);
  return file;
}

/**
 * Bubblewrap's mount and network namespaces, followed by Anthropic's pinned
 * seccomp helper. The helper puts the workload in a second PID namespace:
 * it cannot ptrace the unfiltered relay or reach its /proc handles. There is
 * no optional filter, host /proc, host network or unconfined fallback.
 */
export function linuxModuleCommand(input: {
  bun: string;
  workerPath: string;
  modulePath: string;
  projectRoot: string;
  readable: readonly string[];
  writable: readonly string[];
  proxySocket?: string;
}): {
  command: string;
  args: string[];
  inheritedFds: readonly number[];
  close: () => void;
} {
  const command = systemTool("bwrap");
  if (!checkedBubblewrap) {
    const version = execFileSync(command, ["--version"], { encoding: "utf8" });
    const match = /bubblewrap (\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 12))
      throw new Error(
        "Confined modules require Bubblewrap 0.12 or newer for safe mount setup. Install a current system release.",
      );
    const help = execFileSync(command, ["--help"], { encoding: "utf8" });
    if (!help.includes("--ro-bind-fd"))
      throw new Error(
        "This Bubblewrap build lacks secure file mounts. Install a current system release.",
      );
    checkedBubblewrap = true;
  }
  const helper = seccompHelper();
  const socat = input.proxySocket ? systemTool("socat") : null;
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    // fd 3 is Work's RPC pipe; no other host descriptors cross this boundary.
    "--tmpfs",
    "/",
  ];
  // /usr/local may hold private service configuration. Grant only the
  // distribution runtime, then add the exact Bun/helper files below.
  for (const file of [
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/lib64",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
  ]) {
    if (!fs.existsSync(file)) continue;
    if (fs.lstatSync(file).isSymbolicLink())
      args.push("--symlink", fs.readlinkSync(file), file);
    else args.push("--ro-bind", file, file);
  }
  for (const file of [
    // Public trust bundles, never sibling private key stores.
    "/etc/ssl/certs",
    "/etc/ssl/cert.pem",
    "/etc/pki/ca-trust/extracted",
    "/etc/pki/tls/certs",
    "/etc/pki/tls/cert.pem",
    "/etc/localtime",
    "/etc/ld.so.cache",
    "/etc/nsswitch.conf",
    "/etc/hosts",
    "/etc/resolv.conf",
  ]) {
    if (fs.existsSync(file))
      args.push("--ro-bind", fs.realpathSync(file), file);
  }
  const mounts = new Map<string, boolean>();
  for (const file of [input.projectRoot, helper, ...input.readable])
    mounts.set(file, false);
  for (const file of input.writable) {
    if (!fs.existsSync(file))
      throw new Error(
        `The module's write path does not exist: ${file}. Create the file or directory before running it on Linux.`,
      );
    mounts.set(file, true);
  }
  const pinned: number[] = [];
  const close = () => {
    for (const fd of pinned.splice(0)) fs.closeSync(fd);
  };
  try {
    // Pin the approved inode. Reopening a pathname in bwrap would let another
    // module replace it with a symlink after our canonical access check.
    // O_PATH on Linux arm64/x64; node:fs does not expose this constant.
    const O_PATH = 0o10000000;
    // An allowed child must be mounted after a read-only ancestor.
    for (const [file, write] of [...mounts].sort(
      ([a], [b]) => a.split(path.sep).length - b.split(path.sep).length,
    )) {
      const fd = fs.openSync(file, O_PATH | fs.constants.O_NOFOLLOW);
      pinned.push(fd);
      const source = `/proc/${process.pid}/fd/${fd}`;
      if (fs.fstatSync(fd).isSymbolicLink() || fs.readlinkSync(source) !== file)
        throw new Error(
          "This module's access paths changed. Review its access before running it.",
        );
      // Node duplicates these at 4 onward. Bubblewrap consumes and closes
      // them during setup; none become workload descriptors.
      args.push(
        write ? "--bind-fd" : "--ro-bind-fd",
        String(3 + pinned.length),
        file,
      );
    }
  } catch (error) {
    close();
    throw error;
  }
  args.push("--dev", "/dev", "--proc", "/proc", "--dir", "/run");
  if (input.proxySocket)
    args.push("--ro-bind", input.proxySocket, "/run/work-module-proxy.sock");
  args.push(
    "--remount-ro",
    "/",
    "--chdir",
    input.projectRoot,
    "--setenv",
    "SRT_ALLOW_NESTED_USERNS",
    "0",
  );
  const workload = [helper, input.bun, input.workerPath, input.modulePath];
  if (!socat)
    return {
      command,
      args: [...args, "--", ...workload],
      inheritedFds: pinned,
      close,
    };
  // Only trusted system binaries run before the filter. Positional arguments
  // keep module names and file grants out of shell source and socat syntax.
  const script = `
"$1" TCP4-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr,backlog=64 UNIX-CONNECT:/run/work-module-proxy.sock </dev/null >/dev/null 2>&1 3>&- &
relay=$!
trap 'kill "$relay" 2>/dev/null || true' EXIT
ready=0
for ((i=0;i<300;i++)); do
  kill -0 "$relay" 2>/dev/null || exit 1
  if (echo >/dev/tcp/127.0.0.1/3128) 2>/dev/null; then ready=1; break; fi
  /bin/sleep 0.01
done
[[ $ready = 1 ]] || exit 1
shift
"$@"
`;
  return {
    command,
    inheritedFds: pinned,
    close,
    args: [
      ...args,
      "--",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      script,
      "work-module",
      socat,
      ...workload,
    ],
  };
}
