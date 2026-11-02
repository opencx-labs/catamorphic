import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

type Execute = (command: string, args: string[]) => string;
const execute: Execute = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return `${result.stdout}${result.stderr}`.trim();
};

/**
 * The native helpers a macOS package carries: each must be signed by the
 * app's team, hold both architectures and speak its protocol.
 * `--version` is the only invocation: it reads no Keychain, taps no keys
 * and opens no microphone.
 */
const HELPERS = [
  {
    file: "browser-keychain",
    name: "Browser import helper",
    protocol: "work-browser-keychain 1",
  },
  {
    file: "voice-keys",
    name: "Voice keys helper",
    protocol: "work-voice-keys 1",
  },
  {
    file: "voice-quiet",
    name: "Voice quiet helper",
    protocol: "work-voice-quiet 1",
  },
] as const;

// Electron's V1 wire schema: https://www.electronjs.org/docs/latest/tutorial/fuses
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const RELEASE_FUSES = [
  { name: "runAsNode", index: 0, enabled: false },
  { name: "enableCookieEncryption", index: 1, enabled: true },
  { name: "enableNodeOptionsEnvironmentVariable", index: 2, enabled: false },
  { name: "enableNodeCliInspectArguments", index: 3, enabled: false },
  { name: "enableEmbeddedAsarIntegrityValidation", index: 4, enabled: true },
  { name: "onlyLoadAppFromAsar", index: 5, enabled: true },
  { name: "grantFileProtocolExtraPrivileges", index: 7, enabled: false },
] as const;

/** Inspect every binary slice; a config file alone does not prove packaged fuses. */
export function verifyDesktopFuses({
  binary,
}: {
  binary: Buffer;
}): Record<string, boolean> {
  let position = binary.indexOf(FUSE_SENTINEL);
  let slices = 0;
  if (position < 0) throw new Error("Packaged Electron fuse wire is missing");
  while (position >= 0) {
    slices += 1;
    if (slices > 2)
      throw new Error("Unexpected number of packaged Electron fuse wires");
    const start = position + FUSE_SENTINEL.length;
    const version = binary[start];
    const length = binary[start + 1];
    if (
      version !== 1 ||
      length === undefined ||
      length < 8 ||
      start + 2 + length > binary.length
    )
      throw new Error("Invalid packaged Electron V1 fuse wire");
    for (const fuse of RELEASE_FUSES) {
      if (binary[start + 2 + fuse.index] !== (fuse.enabled ? 0x31 : 0x30))
        throw new Error(
          `Packaged Electron fuse ${fuse.name} must be ${fuse.enabled ? "enabled" : "disabled"}`,
        );
    }
    position = binary.indexOf(FUSE_SENTINEL, start + 2 + length);
  }
  return Object.fromEntries(
    RELEASE_FUSES.map((fuse) => [fuse.name, fuse.enabled]),
  );
}

/** Verify the actual release signatures, never the ad-hoc repository prebuild. */
export function verifyDesktopSignature({
  appPath,
  run = execute,
  readBinary = readFileSync,
}: {
  appPath: string;
  run?: Execute;
  readBinary?: (file: string) => Buffer;
}) {
  const team = (file: string) => {
    run("codesign", ["--verify", "--deep", "--strict", file]);
    const signature = run("codesign", ["--display", "--verbose=4", file]);
    const teamId = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(signature)?.[1];
    if (!/^Authority=Developer ID Application:/m.test(signature) || !teamId)
      throw new Error(`Expected a Developer ID Application signature: ${file}`);
    return teamId;
  };
  const teamId = team(appPath);
  const fuses = verifyDesktopFuses({
    binary: readBinary(
      path.join(
        appPath,
        "Contents/Frameworks/Electron Framework.framework/Electron Framework",
      ),
    ),
  });
  const protocols: Record<string, string> = {};
  for (const helper of HELPERS) {
    const helperPath = path.join(appPath, "Contents/MacOS", helper.file);
    if (team(helperPath) !== teamId)
      throw new Error(`${helper.name} and app must have the same signing team`);
    run("lipo", [helperPath, "-verify_arch", "arm64", "x86_64"]);
    const protocol = run(helperPath, ["--version"]);
    if (protocol !== helper.protocol)
      throw new Error(`${helper.name} has an unsupported protocol`);
    protocols[helper.file] = protocol;
  }
  return { teamId, protocols, architectures: ["arm64", "x86_64"], fuses };
}

if (import.meta.main) {
  const [appPath, ...extra] = process.argv.slice(2);
  if (!appPath || extra.length)
    throw new Error(
      "Usage: bun scripts/desktop-signature.ts <signed Work.app>",
    );
  console.log(JSON.stringify(verifyDesktopSignature({ appPath }), null, 2));
}
