import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DESKTOP_TAG_PREFIX = "desktop-v";
const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_DOWNLOAD_ROOT =
  "https://github.com/opencx-labs/catamorphic/releases/download";

export function verifyDesktopRelease(input: {
  tag: string;
  packageVersion: string;
}): { version: string; kind: DesktopReleaseKind } {
  if (!input.tag.startsWith(DESKTOP_TAG_PREFIX)) {
    throw new Error(
      `Desktop release tag must start with ${DESKTOP_TAG_PREFIX}`,
    );
  }
  const version = input.tag.slice(DESKTOP_TAG_PREFIX.length);
  const kind = desktopReleaseKind(version);
  if (version !== input.packageVersion) {
    throw new Error(
      `Desktop release tag version ${version} does not match package version ${input.packageVersion}`,
    );
  }
  return { version, kind };
}

export type DesktopReleaseKind = "stable" | "preview";

export function desktopReleaseKind(version: string): DesktopReleaseKind {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`Desktop release version must be valid SemVer: ${version}`);
  }
  const prerelease = version.split("-")[1];
  if (!prerelease) return "stable";
  if (prerelease.split(".")[0] !== "alpha") {
    throw new Error(
      `Desktop preview versions must use the alpha prerelease channel: ${version}`,
    );
  }
  return "preview";
}

export function renderHomebrewCask(input: {
  version: string;
  sha256: string;
  channel: DesktopReleaseKind;
}): string {
  desktopReleaseKind(input.version);
  if (!SHA256.test(input.sha256)) {
    throw new Error(
      "Homebrew cask SHA-256 must be 64 lowercase hexadecimal characters",
    );
  }

  const token =
    input.channel === "stable" ? "catamorphic" : "catamorphic@alpha";
  const conflictingToken =
    input.channel === "stable" ? "catamorphic@alpha" : "catamorphic";

  return `cask "${token}" do
  version "${input.version}"
  sha256 "${input.sha256}"

  url "https://github.com/opencx-labs/catamorphic/releases/download/desktop-v#{version}/Catamorphic-#{version}-arm64.dmg"
  name "Catamorphic"
  desc "Local-first workspace for projects, agents, workflows, and apps"
  homepage "https://github.com/opencx-labs/catamorphic"

  auto_updates true
  conflicts_with cask: "${conflictingToken}"
  depends_on arch: :arm64
  depends_on macos: :monterey

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

export function desktopUpdateMetadataName(version: string): string {
  return desktopReleaseKind(version) === "stable"
    ? "latest-mac.yml"
    : "alpha-mac.yml";
}

export function rewriteDesktopUpdateMetadata(input: {
  version: string;
  content: string;
}): string {
  const metadataName = desktopUpdateMetadataName(input.version);
  let content = input.content;
  for (const extension of ["dmg", "zip"] as const) {
    const artifact = `Catamorphic-${input.version}-arm64.${extension}`;
    if (!content.includes(artifact)) {
      throw new Error(`${metadataName} does not reference ${artifact}`);
    }
    const url = `${RELEASE_DOWNLOAD_ROOT}/desktop-v${input.version}/${artifact}`;
    content = content.replaceAll(artifact, url);
  }
  return content;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function caskChannel(value: string): DesktopReleaseKind {
  if (value === "stable" || value === "preview") return value;
  throw new Error(`Desktop cask channel must be stable or preview: ${value}`);
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
  if (command === "release-kind") {
    process.stdout.write(`${desktopReleaseKind(option("--version"))}\n`);
    return;
  }
  if (command === "write-cask") {
    const output = option("--output");
    const cask = renderHomebrewCask({
      version: option("--version"),
      sha256: option("--sha256"),
      channel: caskChannel(option("--channel")),
    });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, cask, "utf8");
    return;
  }
  if (command === "update-metadata-name") {
    process.stdout.write(`${desktopUpdateMetadataName(option("--version"))}\n`);
    return;
  }
  if (command === "prepare-update-metadata") {
    const input = option("--input");
    const content = rewriteDesktopUpdateMetadata({
      version: option("--version"),
      content: readFileSync(input, "utf8"),
    });
    writeFileSync(input, content, "utf8");
    return;
  }
  throw new Error(
    "Usage: desktop-release.ts <verify|release-kind|write-cask|update-metadata-name|prepare-update-metadata> [options]",
  );
}

if (import.meta.main) main();
