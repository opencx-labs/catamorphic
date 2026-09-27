import { describe, expect, it } from "vitest";
import { harnessPermissionIssues } from "../coding-agent/harness-permissions.js";
import {
  SANDBOXING_LEVELS,
  sandboxingAllows,
  sandboxingRefusal,
} from "../sandbox-environment.js";

describe("sandboxing", () => {
  it("orders contained, propose, publish", () => {
    expect(SANDBOXING_LEVELS).toEqual(["contained", "propose", "publish"]);
    expect(
      sandboxingAllows({ sandboxing: "contained", required: "contained" }),
    ).toBe(true);
    expect(
      sandboxingAllows({ sandboxing: "contained", required: "propose" }),
    ).toBe(false);
    expect(
      sandboxingAllows({ sandboxing: "propose", required: "propose" }),
    ).toBe(true);
    expect(
      sandboxingAllows({ sandboxing: "propose", required: "publish" }),
    ).toBe(false);
    expect(
      sandboxingAllows({ sandboxing: "publish", required: "publish" }),
    ).toBe(true);
  });

  it("names the level and what the agent may do instead", () => {
    expect(
      sandboxingRefusal({ sandboxing: "contained", action: "push" }),
    ).toMatch(/sandboxing is contained: .*not push\. Report what you found/);
    expect(
      sandboxingRefusal({ sandboxing: "propose", action: "deploy" }),
    ).toMatch(/sandboxing is propose: .*not deploy\. Propose the change/);
  });
});

describe("harness permissions", () => {
  it("accepts each harness's own settings", () => {
    expect(
      harnessPermissionIssues({
        kind: "claude-code",
        permissions: { permissionMode: "auto" },
      }),
    ).toEqual([]);
    expect(
      harnessPermissionIssues({
        kind: "codex",
        permissions: { sandbox: "danger-full-access", approvals: "never" },
      }),
    ).toEqual([]);
    expect(
      harnessPermissionIssues({ kind: "builtin", permissions: {} }),
    ).toEqual([]);
  });

  it("refuses settings another harness owns", () => {
    expect(
      harnessPermissionIssues({
        kind: "claude-code",
        permissions: { sandbox: "read-only" },
      }),
    ).toEqual([
      {
        field: "sandbox",
        message: "A claude-code agent takes 'permissionMode', not 'sandbox'",
      },
    ]);
    expect(
      harnessPermissionIssues({
        kind: "codex",
        permissions: { permissionMode: "plan" },
      }).map((issue) => issue.field),
    ).toEqual(["permissionMode"]);
    expect(
      harnessPermissionIssues({
        kind: "builtin",
        permissions: { approvals: "never" },
      }),
    ).toEqual([
      {
        field: "approvals",
        message:
          "A builtin agent has no harness permission settings; remove 'approvals'",
      },
    ]);
  });
});
