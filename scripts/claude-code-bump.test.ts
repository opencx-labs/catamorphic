import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyRelease,
  componentTargets,
  pinnedSdkVersion,
} from "./claude-code-bump.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const files = {
  packageJson: read("packages/claude-code/package.json"),
  components: read("apps/desktop/src/main/harness-components.ts"),
};

describe("Claude Code pins", () => {
  it("keep the SDK, its CLI release and the desktop download in step", () => {
    const sdk = pinnedSdkVersion(files.packageJson);
    const installed: { version: string; claudeCodeVersion: string } =
      JSON.parse(
        read(
          "packages/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        ),
      );
    expect(installed.version).toBe(sdk);
    expect(files.components).toContain(`const CLAUDE_VERSION = "${sdk}";`);
    expect(files.components).toContain(
      `export const CLAUDE_CODE_MIN_VERSION = "${installed.claudeCodeVersion}";`,
    );
  });

  it("rewrites every pin for a release and refuses a missing platform", () => {
    const targets = componentTargets(files.components);
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
    const next = applyRelease(files, {
      sdkVersion: "9.9.9",
      cliVersion: "8.8.8",
      integrity,
    });
    expect(pinnedSdkVersion(next.packageJson)).toBe("9.9.9");
    expect(next.components).toContain('const CLAUDE_VERSION = "9.9.9";');
    expect(next.components).toContain(
      'export const CLAUDE_CODE_MIN_VERSION = "8.8.8";',
    );
    for (const target of targets)
      expect(next.components).toContain(`"sha512-${target}=="`);
    // Codex and Bun pins stay as they were.
    const others = (source: string) =>
      [
        ...source.matchAll(
          /(CODEX_VERSION = |BUN_VERSION = |codexIntegrity:\s*|bunIntegrity:\s*)"([^"]+)"/g,
        ),
      ].map((match) => `${match[1]}=${match[2]}`);
    expect(others(next.components)).toHaveLength(14);
    expect(others(next.components)).toEqual(others(files.components));
    const { "win32-x64": _, ...partial } = integrity;
    expect(() =>
      applyRelease(files, {
        sdkVersion: "9.9.9",
        cliVersion: "8.8.8",
        integrity: partial,
      }),
    ).toThrow("win32-x64");
  });
});
