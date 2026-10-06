import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** Whether microsandbox can run on this machine, and why not. */
export type MicrosandboxSupport = { ok: true } | { ok: false; reason: string };

const NO_KVM =
  "This machine has no usable /dev/kvm, so microsandbox cannot run here. Use WORK_SANDBOX=container (gVisor) or auto.";

/**
 * Whether microsandbox can run here (ADR 0204): an Apple silicon Mac, or
 * Linux (x64, arm64) with a `/dev/kvm` this process may open read-write;
 * and an `msb` runtime the SDK resolves (`MSB_PATH`, the runtime home's
 * `~/.microsandbox/bin/msb`, or the SDK's platform package).
 */
export function microsandboxSupport(input?: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
  /** Checks `/dev/kvm`; the real device by default. */
  kvmUsable?: () => boolean;
  /** Finds the msb binary; the SDK's own order by default. */
  msbPath?: () => string | undefined;
}): MicrosandboxSupport {
  const platform = input?.platform ?? process.platform;
  const arch = input?.arch ?? process.arch;
  const env = input?.env ?? process.env;
  if (platform === "darwin") {
    if (arch !== "arm64")
      return {
        ok: false,
        reason: "Microsandbox runs on Apple silicon Macs only",
      };
  } else if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64")
      return {
        ok: false,
        reason: `Microsandbox does not run on Linux ${arch}`,
      };
    if (!(input?.kvmUsable ?? kvmUsable)())
      return { ok: false, reason: NO_KVM };
  } else {
    return {
      ok: false,
      reason: `Microsandbox does not run on ${platform}`,
    };
  }
  const msb = (input?.msbPath ?? (() => resolveMsb(env)))();
  if (!msb)
    return {
      ok: false,
      reason:
        "The microsandbox runtime (msb) is not installed on this machine: install it, or set MSB_PATH to its msb binary",
    };
  return { ok: true };
}

/** Whether `/dev/kvm` exists and opens read-write. */
function kvmUsable(): boolean {
  try {
    fs.closeSync(fs.openSync("/dev/kvm", "r+"));
    return true;
  } catch {
    return false;
  }
}

/** The msb binary, in the order the SDK looks for it. */
function resolveMsb(
  env: Record<string, string | undefined>,
): string | undefined {
  const candidates = [
    env.MSB_PATH,
    path.join(os.homedir(), ".microsandbox", "bin", "msb"),
    packagedMsb(),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      Boolean(candidate) && executable(candidate ?? ""),
  );
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The msb in the SDK's platform package, which sits beside the SDK. */
function packagedMsb(): string | undefined {
  const triples: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x64-gnu",
    "linux-arm64": "linux-arm64-gnu",
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) return undefined;
  try {
    const sdk = createRequire(import.meta.url).resolve(
      "microsandbox/package.json",
    );
    const platformPackage = createRequire(sdk).resolve(
      `@superradcompany/microsandbox-${triple}/package.json`,
    );
    return path.join(path.dirname(platformPackage), "bin", "msb");
  } catch {
    return undefined;
  }
}
