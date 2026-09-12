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

/** Verify the actual release signatures, never the ad-hoc repository prebuild. */
export function verifyDesktopSignature({
  appPath,
  run = execute,
}: {
  appPath: string;
  run?: Execute;
}) {
  const helperPath = path.join(appPath, "Contents/MacOS/browser-keychain");
  const team = (file: string) => {
    run("codesign", ["--verify", "--deep", "--strict", file]);
    const signature = run("codesign", ["--display", "--verbose=4", file]);
    const teamId = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(signature)?.[1];
    if (!/^Authority=Developer ID Application:/m.test(signature) || !teamId)
      throw new Error(`Expected a Developer ID Application signature: ${file}`);
    return teamId;
  };
  const teamId = team(appPath);
  if (team(helperPath) !== teamId)
    throw new Error(
      "Browser import helper and app must have the same signing team",
    );
  run("lipo", [helperPath, "-verify_arch", "arm64", "x86_64"]);
  // --version never accesses Keychain and is the only helper invocation here.
  const protocol = run(helperPath, ["--version"]);
  if (protocol !== "catamorphic-browser-keychain 1")
    throw new Error("Browser import helper has an unsupported protocol");
  return { teamId, protocol, architectures: ["arm64", "x86_64"] };
}

if (import.meta.main) {
  const [appPath, ...extra] = process.argv.slice(2);
  if (!appPath || extra.length)
    throw new Error(
      "Usage: bun scripts/desktop-signature.ts <signed Catamorphic.app>",
    );
  console.log(JSON.stringify(verifyDesktopSignature({ appPath }), null, 2));
}
