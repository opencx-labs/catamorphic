import { spawnSync } from "node:child_process";
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
 * `--version` is the only invocation: it reads no Keychain and taps no
 * keys.
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
] as const;

/** Verify the actual release signatures, never the ad-hoc repository prebuild. */
export function verifyDesktopSignature({
  appPath,
  run = execute,
}: {
  appPath: string;
  run?: Execute;
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
  return { teamId, protocols, architectures: ["arm64", "x86_64"] };
}

if (import.meta.main) {
  const [appPath, ...extra] = process.argv.slice(2);
  if (!appPath || extra.length)
    throw new Error(
      "Usage: bun scripts/desktop-signature.ts <signed Work.app>",
    );
  console.log(JSON.stringify(verifyDesktopSignature({ appPath }), null, 2));
}
