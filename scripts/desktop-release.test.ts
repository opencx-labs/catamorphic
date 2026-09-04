import { describe, expect, it } from "vitest";
import {
  desktopReleaseKind,
  desktopUpdateMetadataName,
  renderHomebrewCask,
  rewriteDesktopUpdateMetadata,
  verifyDesktopRelease,
} from "./desktop-release.js";

describe("verifyDesktopRelease", () => {
  it("accepts a matching desktop prerelease tag", () => {
    expect(
      verifyDesktopRelease({
        tag: "desktop-v0.1.0-alpha.1",
        packageVersion: "0.1.0-alpha.1",
      }),
    ).toEqual({ version: "0.1.0-alpha.1", kind: "preview" });
  });

  it("accepts a matching stable desktop tag", () => {
    expect(
      verifyDesktopRelease({
        tag: "desktop-v1.0.0",
        packageVersion: "1.0.0",
      }),
    ).toEqual({ version: "1.0.0", kind: "stable" });
  });

  it("rejects unrelated, unsupported-channel, and mismatched tags", () => {
    expect(() =>
      verifyDesktopRelease({
        tag: "v0.1.0-alpha.1",
        packageVersion: "0.1.0-alpha.1",
      }),
    ).toThrow("must start with desktop-v");
    expect(() =>
      verifyDesktopRelease({
        tag: "desktop-v0.1.0-nightly.1",
        packageVersion: "0.1.0-nightly.1",
      }),
    ).toThrow("must use the alpha prerelease channel");
    expect(() =>
      verifyDesktopRelease({
        tag: "desktop-v0.1.0-alpha.2",
        packageVersion: "0.1.0-alpha.1",
      }),
    ).toThrow("does not match package version");
  });
});

describe("renderHomebrewCask", () => {
  it("renders the preview cask for the tagged GitHub DMG", () => {
    const cask = renderHomebrewCask({
      version: "0.1.0-alpha.1",
      sha256: "a".repeat(64),
      channel: "preview",
    });

    expect(cask).toContain('cask "catamorphic@alpha"');
    expect(cask).toContain('version "0.1.0-alpha.1"');
    expect(cask).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(cask).toContain(
      "releases/download/desktop-v#{version}/Catamorphic-#{version}-arm64.dmg",
    );
    expect(cask).toContain("depends_on arch: :arm64");
    expect(cask).toContain("auto_updates true");
    expect(cask).toContain('conflicts_with cask: "catamorphic"');
    expect(cask).toContain('app "Catamorphic.app"');
  });

  it("can point both stable and preview casks at a stable release", () => {
    const stable = renderHomebrewCask({
      version: "1.0.0",
      sha256: "b".repeat(64),
      channel: "stable",
    });
    const preview = renderHomebrewCask({
      version: "1.0.0",
      sha256: "b".repeat(64),
      channel: "preview",
    });

    expect(stable).toContain('cask "catamorphic"');
    expect(stable).toContain('conflicts_with cask: "catamorphic@alpha"');
    expect(preview).toContain('cask "catamorphic@alpha"');
  });

  it("rejects an invalid checksum", () => {
    expect(() =>
      renderHomebrewCask({
        version: "0.1.0-alpha.1",
        sha256: "not-a-checksum",
        channel: "preview",
      }),
    ).toThrow("SHA-256");
  });
});

describe("desktop update metadata", () => {
  it("derives the channel filename and points artifacts at the tagged release", () => {
    const version = "0.1.0-alpha.2";
    expect(desktopUpdateMetadataName(version)).toBe("alpha-mac.yml");

    const metadata = rewriteDesktopUpdateMetadata({
      version,
      content: `version: ${version}\nfiles:\n  - url: Catamorphic-${version}-arm64.zip\n    sha512: zip-sha\npath: Catamorphic-${version}-arm64.dmg\nsha512: dmg-sha\n`,
    });

    expect(metadata).toContain(
      `releases/download/desktop-v${version}/Catamorphic-${version}-arm64.zip`,
    );
    expect(metadata).toContain(
      `releases/download/desktop-v${version}/Catamorphic-${version}-arm64.dmg`,
    );
    expect(metadata).toContain("sha512: zip-sha");
    expect(metadata).toContain("sha512: dmg-sha");
  });

  it("uses latest metadata for stable releases", () => {
    expect(desktopReleaseKind("1.0.0")).toBe("stable");
    expect(desktopReleaseKind("1.1.0-alpha.4")).toBe("preview");
    expect(desktopUpdateMetadataName("1.0.0")).toBe("latest-mac.yml");
  });

  it("rejects incomplete generated metadata", () => {
    expect(() =>
      rewriteDesktopUpdateMetadata({
        version: "0.1.0-alpha.2",
        content: "path: Catamorphic-0.1.0-alpha.2-arm64.dmg\n",
      }),
    ).toThrow("does not reference Catamorphic-0.1.0-alpha.2-arm64.zip");
  });
});
