import { describe, expect, it } from "vitest";
import { createDevPlan, sanitizeInstanceName } from "./dev-plan.js";

const ports = {
  desktopCdp: 9311,
  desktopVite: 5178,
  server: 4705,
  operator: 4706,
};

describe("sanitizeInstanceName", () => {
  it("collapses unsafe characters to single hyphens", () => {
    expect(sanitizeInstanceName(" Feature /// QA...Run ")).toBe(
      "feature-qa-run",
    );
  });
});

describe("createDevPlan", () => {
  it("distinguishes worktrees with identical basenames", () => {
    const first = createDevPlan({
      rootPath: "/workspace/team-one/catamorphic",
      tempPath: "/tmp",
      target: "all",
      ports,
    });
    const second = createDevPlan({
      rootPath: "/workspace/team-two/catamorphic",
      tempPath: "/tmp",
      target: "all",
      ports,
    });

    expect(first.instance).toBe("catamorphic-80f70ed3");
    expect(second.instance).toBe("catamorphic-e0b62b2c");
  });

  it("uses the sanitized explicit instance override", () => {
    const plan = createDevPlan({
      rootPath: "/workspace/team-one/catamorphic",
      tempPath: "/private/tmp",
      instanceOverride: " Feature /// QA...Run ",
      target: "all",
      ports,
    });

    expect(plan.instance).toBe("feature-qa-run");
    expect(plan.desktopDataDir).toBe(
      "/private/tmp/catamorphic-dev/feature-qa-run/desktop",
    );
    expect(plan.serverDataDir).toBe(
      "/private/tmp/catamorphic-dev/feature-qa-run/server",
    );
    expect(plan.lockPath).toBe(
      "/private/tmp/catamorphic-dev/feature-qa-run/dev.lock",
    );
  });

  it("rejects an explicitly empty instance override", () => {
    expect(() =>
      createDevPlan({
        rootPath: "/workspace/team-one/catamorphic",
        tempPath: "/private/tmp",
        instanceOverride: "",
        target: "all",
        ports,
      }),
    ).toThrow("Development instance name must contain a letter or number");
  });

  it("builds one combined Turbo argument list for all apps", () => {
    const plan = createDevPlan({
      rootPath: "/workspace/team-one/catamorphic",
      tempPath: "/tmp",
      target: "all",
      ports,
    });

    expect(plan.turboArgs).toEqual([
      "run",
      "dev",
      "--no-daemon",
      "--concurrency=64",
      "--filter=catamorphic-desktop...",
      "--filter=catamorphic-server...",
    ]);
  });

  it.each([
    ["desktop", "--filter=catamorphic-desktop..."],
    ["server", "--filter=catamorphic-server..."],
  ] as const)("builds an app-specific Turbo list for %s", (target, filter) => {
    const plan = createDevPlan({
      rootPath: "/workspace/team-one/catamorphic",
      tempPath: "/tmp",
      target,
      ports,
    });

    expect(plan.turboArgs).toEqual([
      "run",
      "dev",
      "--no-daemon",
      "--concurrency=64",
      filter,
    ]);
  });

  it("sets literal worktree paths and reserved ports in the app environment", () => {
    const plan = createDevPlan({
      rootPath: "/workspace/team-one/catamorphic",
      tempPath: "/private/tmp",
      instanceOverride: "qa",
      target: "all",
      ports,
    });

    expect(plan.env).toEqual({
      CATAMORPHIC_DESKTOP_DATA_DIR: "/private/tmp/catamorphic-dev/qa/desktop",
      CATAMORPHIC_DESKTOP_CDP_PORT: "9311",
      CATAMORPHIC_DESKTOP_VITE_PORT: "5178",
      CATAMORPHIC_DATA_DIR: "/private/tmp/catamorphic-dev/qa/server",
      PORT: "4705",
      CATAMORPHIC_OPERATOR_PORT: "4706",
      CATAMORPHIC_PUBLIC_URL: "http://127.0.0.1:4705",
      CATAMORPHIC_MDNS: "off",
    });
  });
});
