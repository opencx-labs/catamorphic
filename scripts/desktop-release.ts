import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DESKTOP_TAG_PREFIX = "desktop-v";
const PRERELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function verifyDesktopRelease(input: {
  tag: string;
  packageVersion: string;
}): { version: string } {
  if (!input.tag.startsWith(DESKTOP_TAG_PREFIX)) {
    throw new Error(
      `Desktop release tag must start with ${DESKTOP_TAG_PREFIX}`,
    );
  }
  const version = input.tag.slice(DESKTOP_TAG_PREFIX.length);
  if (!PRERELEASE_VERSION.test(version)) {
    throw new Error(
      `Desktop release version must be a SemVer prerelease: ${version}`,
    );
  }
  if (version !== input.packageVersion) {
    throw new Error(
      `Desktop release tag version ${version} does not match package version ${input.packageVersion}`,
    );
  }
  return { version };
}

export function renderHomebrewCask(input: {
  version: string;
  sha256: string;
}): string {
  if (!PRERELEASE_VERSION.test(input.version)) {
    throw new Error(
      `Homebrew cask version must be a SemVer prerelease: ${input.version}`,
    );
  }
  if (!SHA256.test(input.sha256)) {
    throw new Error(
      "Homebrew cask SHA-256 must be 64 lowercase hexadecimal characters",
    );
  }

  return `cask "catamorphic" do
  version "${input.version}"
  sha256 "${input.sha256}"

  url "https://github.com/opencx-labs/catamorphic/releases/download/desktop-v#{version}/Catamorphic-#{version}-arm64.dmg"
  name "Catamorphic"
  desc "Local-first workspace for projects, agents, workflows, and apps"
  homepage "https://github.com/opencx-labs/catamorphic"

  depends_on arch: :arm64
  depends_on macos: ">= :monterey"

  app "Catamorphic.app"

  zap trash: [
    "~/Library/Application Support/Catamorphic",
    "~/Library/Logs/Catamorphic",
    "~/Library/Preferences/dev.catamorphic.desktop.plist",
    "~/Library/Saved Application State/dev.catamorphic.desktop.savedState",
  ]
end
`;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function main(): void {
  const command = process.argv[2];
  if (command === "verify") {
    const result = verifyDesktopRelease({
      tag: option("--tag"),
      packageVersion: option("--package-version"),
    });
    process.stdout.write(`${result.version}\n`);
    return;
  }
  if (command === "write-cask") {
    const output = option("--output");
    const cask = renderHomebrewCask({
      version: option("--version"),
      sha256: option("--sha256"),
    });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, cask, "utf8");
    return;
  }
  throw new Error("Usage: desktop-release.ts <verify|write-cask> [options]");
}

if (import.meta.main) main();
