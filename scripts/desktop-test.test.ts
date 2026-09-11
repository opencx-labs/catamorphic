import { describe, expect, it } from "vitest";
import {
  desktopVitestArguments,
  includeDesktopTestSource,
} from "./desktop-test.js";
import { isIsolatedDesktopTestHost } from "./desktop-test-environment.js";

describe("desktop test isolation", () => {
  it("rejects ordinary desktops, including CI flags on a developer Mac", () => {
    for (const env of [
      {},
      { CI: "true" },
      { CATAMORPHIC_E2E_PRIVATE_DISPLAY: "1" },
      { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
    ]) {
      expect(isIsolatedDesktopTestHost({ platform: "darwin", env })).toBe(
        false,
      );
    }
    expect(
      isIsolatedDesktopTestHost({ platform: "linux", env: { DISPLAY: ":0" } }),
    ).toBe(false);
    expect(
      isIsolatedDesktopTestHost({
        platform: "linux",
        env: { DISPLAY: "host:0", CATAMORPHIC_E2E_PRIVATE_DISPLAY: "1" },
      }),
    ).toBe(false);
  });

  it("accepts a private Linux X server and dedicated hosted macOS", () => {
    expect(
      isIsolatedDesktopTestHost({
        platform: "linux",
        env: {
          DISPLAY: ":99",
          CATAMORPHIC_E2E_PRIVATE_DISPLAY: "1",
        },
      }),
    ).toBe(true);
    expect(
      isIsolatedDesktopTestHost({
        platform: "darwin",
        env: {
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
        },
      }),
    ).toBe(true);
  });

  it("excludes credentials, host dependencies, and generated output from the snapshot", () => {
    for (const file of [
      ".env",
      ".env.local",
      "apps/desktop/.env",
      "key.p8",
      "signing.p12",
      ".git",
      "packages/core/node_modules/x/index.js",
      "apps/desktop/out/main.js",
      "packages/app/dist/index.js",
      "test-results/log.txt",
      ".claude/settings.local.json",
    ]) {
      expect(includeDesktopTestSource(file), file).toBe(false);
    }
    for (const file of [
      "bun.lock",
      "package.json",
      "packages/core/package.json",
      "apps/desktop/e2e/new.e2e.ts",
      "packages/core/src/new.ts",
    ]) {
      expect(includeDesktopTestSource(file), file).toBe(true);
    }
  });

  it("preserves file filters and shard selection through the pinned Node entrypoint", () => {
    const args = desktopVitestArguments({
      args: ["window-state", "--shard=2/8"],
      artifacts: "/tmp/results",
    });
    expect(args.slice(0, 4)).toEqual([
      "scripts/tool-runtime.ts",
      "vitest",
      "--tool-cwd",
      "apps/desktop",
    ]);
    expect(args.slice(-2)).toEqual(["window-state", "--shard=2/8"]);
    expect(args).toContain("--outputFile.junit=/tmp/results/junit.xml");
  });
});
