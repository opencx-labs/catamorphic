import { describe, expect, it } from "vitest";
import { checkCommands } from "./check-plan.js";

describe("checkCommands", () => {
  it("returns the complete verification phases in literal order", () => {
    expect(checkCommands().map((phase) => phase.label)).toEqual([
      "lint",
      "typecheck",
      "build",
      "database migration",
      "database codegen",
      "generated-type diff check",
      "deterministic workspace tests",
      "PWA E2E",
      "desktop visible E2E",
      "desktop hidden E2E",
    ]);
  });

  it("does not include opt-in external integrations or model evals", () => {
    for (const phase of checkCommands()) {
      const invocation = [phase.command, ...phase.args].join(" ");
      expect(invocation).not.toContain("test:external");
      expect(invocation).not.toContain("test:eval");
    }
  });
});
