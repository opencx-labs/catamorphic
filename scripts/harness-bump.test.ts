import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyRelease,
  componentTargets,
  HARNESSES,
  pinnedSdkVersion,
} from "./harness-bump.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const components = read("apps/desktop/src/main/harness-components.ts");
const constant = (name: string) =>
  new RegExp(`const ${name} = "([^"]+)";`).exec(components)?.[1];
/** Every pin in harness-components.ts, as name=value lines. */
const pins = (source: string) =>
  [
    ...source.matchAll(
      /((?:CLAUDE|CODEX|BUN)_[A-Z_]+ = |(?:claude|codex|bun)Integrity:\s*)"([^"]+)"/g,
    ),
  ].map((match) => `${match[1]?.replace(/[\s:=]+$/, "")}=${match[2]}`);

const installed = (packageDirectory: string, name: string) => {
  const manifest: {
    version: string;
    claudeCodeVersion?: string;
    dependencies?: Record<string, string>;
  } = JSON.parse(read(`${packageDirectory}/node_modules/${name}/package.json`));
  return manifest;
};

describe("harness pins", () => {
  it("keep Claude Code's SDK, its CLI release and the desktop download in step", () => {
    const harness = HARNESSES["claude-code"];
    const sdk = pinnedSdkVersion(harness, read(harness.packageJson));
    const manifest = installed("packages/claude-code", harness.sdk);
    expect(manifest.version).toBe(sdk);
    expect(constant("CLAUDE_VERSION")).toBe(sdk);
    expect(constant("CLAUDE_CODE_MIN_VERSION")).toBe(
      manifest.claudeCodeVersion,
    );
  });

  it("keep Codex's SDK and the desktop download in step", () => {
    const harness = HARNESSES.codex;
    const sdk = pinnedSdkVersion(harness, read(harness.packageJson));
    const manifest = installed("packages/codex", harness.sdk);
    expect(manifest.version).toBe(sdk);
    expect(constant("CODEX_VERSION")).toBe(
      manifest.dependencies?.["@openai/codex"],
    );
  });

  it.each(["claude-code", "codex"] as const)(
    "rewrites only %s's pins for a release and refuses a missing platform",
    (name) => {
      const harness = HARNESSES[name];
      const files = {
        packageJson: read(harness.packageJson),
        components,
      };
      const targets = componentTargets(components);
      expect(targets).toEqual([
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "win32-arm64",
        "win32-x64",
      ]);
      const integrity = Object.fromEntries(
        targets.map((target) => [target, `sha512-${target}==` as const]),
      );
      const next = applyRelease(harness, files, {
        sdkVersion: "9.9.9",
        cliVersion: "8.8.8",
        integrity,
      });
      expect(pinnedSdkVersion(harness, next.packageJson)).toBe("9.9.9");
      const expected = pins(components).map((pin) => {
        const [key] = pin.split("=");
        if (key === harness.cliConstant) return `${key}=8.8.8`;
        if (key === harness.sdkConstant) return `${key}=9.9.9`;
        return pin;
      });
      const integrityPins = expected.filter((pin) =>
        pin.startsWith(`${harness.integrityKey}=`),
      );
      expect(integrityPins).toHaveLength(6);
      expect(pins(next.components)).toEqual(
        expected.map((pin) =>
          pin.startsWith(`${harness.integrityKey}=`)
            ? `${harness.integrityKey}=sha512-${targets[integrityPins.indexOf(pin)]}==`
            : pin,
        ),
      );
      const { "win32-x64": _, ...partial } = integrity;
      expect(() =>
        applyRelease(harness, files, {
          sdkVersion: "9.9.9",
          cliVersion: "8.8.8",
          integrity: partial,
        }),
      ).toThrow("win32-x64");
    },
  );
});
