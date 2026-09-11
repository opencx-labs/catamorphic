import { describe, expect, it } from "vitest";
import { checkCommands, checkOptions } from "./check-plan.js";

describe("checkCommands", () => {
  it("partitions validation and workspace work without losing or duplicating a phase", () => {
    const input = { generatedTypesBaseline: "/tmp/baseline.ts" };
    const phases = [
      ...checkCommands({ ...input, lane: "validation" }),
      ...checkCommands({ ...input, lane: "workspace" }),
    ];
    expect(phases).toEqual(checkCommands(input).slice(0, 9));
    expect(
      checkCommands({ ...input, lane: "workspace", shard: "2/4" })[0]?.args,
    ).toEqual([
      "scripts/tool-runtime.ts",
      "turbo",
      "run",
      "test",
      "--no-daemon",
      "--concurrency=2",
      "--force",
      "--output-logs=new-only",
      "--summarize",
    ]);
  });

  it("reuses tasks only when the CI caller opts in", () => {
    const args = checkCommands({
      generatedTypesBaseline: "/tmp/baseline.ts",
      lane: "workspace",
      shard: "1/2",
      reuseTests: true,
    })[0]?.args;
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--shard=1/2");
    expect(args).toContain("--summarize");
  });

  it("rejects invalid shards and unknown lanes before starting infrastructure", () => {
    expect(checkOptions(["--lane=workspace", "--shard=2/4"])).toEqual({
      lane: "workspace",
      shard: "2/4",
    });
    for (const args of [
      ["--lane=other"],
      ["--shard=1/4"],
      ["--lane=workspace", "--shard=5/4"],
      ["--lane=workspace", "--shard=0/4"],
      ["--skip-tests"],
    ]) {
      expect(() => checkOptions(args)).toThrow();
    }
  });
  it("compares generated types against the pre-run file, not the Git index", () => {
    const phase = checkCommands({
      generatedTypesBaseline: "/tmp/baseline.ts",
    }).find((phase) => phase.label === "generated-type diff check");
    expect(phase?.args).toEqual([
      "diff",
      "--no-index",
      "--exit-code",
      "--",
      "/tmp/baseline.ts",
      "packages/db/src/generated/db.ts",
    ]);
  });
  it("returns the complete verification phases in literal order", () => {
    expect(
      checkCommands({ generatedTypesBaseline: "/tmp/db-types-before.ts" }).map(
        (phase) => phase.label,
      ),
    ).toEqual([
      "lint",
      "root orchestration typecheck",
      "workspace typecheck",
      "build",
      "database migration",
      "database codegen",
      "generated-type diff check",
      "root orchestration tests",
      "deterministic workspace tests",
      "PWA E2E",
      "desktop E2E",
    ]);
  });

  it("keeps root scripts in both typed and tested merge-gate phases", () => {
    expect(
      checkCommands({
        generatedTypesBaseline: "/tmp/db-types-before.ts",
      }).filter((phase) => phase.label.includes("orchestration")),
    ).toEqual([
      {
        label: "root orchestration typecheck",
        command: "bun",
        args: ["run", "typecheck:scripts"],
      },
      {
        label: "root orchestration tests",
        command: "bun",
        args: ["run", "test:scripts"],
      },
    ]);
  });

  it("does not include opt-in external integrations or model evals", () => {
    for (const phase of checkCommands({
      generatedTypesBaseline: "/tmp/db-types-before.ts",
    })) {
      const invocation = [phase.command, ...phase.args].join(" ");
      expect(invocation).not.toContain("test:external");
      expect(invocation).not.toContain("test:eval");
    }
  });
});
