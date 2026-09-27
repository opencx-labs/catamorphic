import { describe, expect, it } from "vitest";
import {
  agentPermissionView,
  permissionModeChoices,
} from "./agent-permissions.js";
import type { AgentInfo } from "./desktop-api.js";

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "agent-1",
    name: "Claude",
    harness: "claude-code",
    model: "",
    effort: "medium",
    auth: "local",
    hasApiKey: false,
    apiKeyMasked: null,
    accepts: ["image", "document"],
    instructions: "",
    sandboxing: "publish",
    harnessPermissions: { permissionMode: "bypassPermissions" },
    coordination: "shared-first",
    memory: false,
    connections: { mode: "all" },
    skills: { mode: "all" },
    toolPolicies: {},
    delegation: { enabled: true, maxConcurrentChildren: 10, routes: [] },
    ...overrides,
  };
}

describe("permission-mode picker (ADR 0182)", () => {
  it("offers Claude Code's own modes and marks the current one", () => {
    const choices = permissionModeChoices(
      agent({ harnessPermissions: { permissionMode: "auto" } }),
    );
    expect(choices.map((choice) => choice.label)).toEqual([
      "Default",
      "Accept edits",
      "Plan",
      "Auto",
      "Don't ask",
      "Bypass permissions",
    ]);
    expect(choices.filter((choice) => choice.current)).toMatchObject([
      { label: "Auto", patch: { permissionMode: "auto" } },
    ]);
  });

  it("offers Codex's sandbox and approvals as separate settings", () => {
    const choices = permissionModeChoices(
      agent({
        harness: "codex",
        harnessPermissions: {
          sandbox: "workspace-write",
          approvals: "on-request",
        },
      }),
    );
    expect(choices.map((choice) => choice.label)).toEqual([
      "Codex sandbox: Read only",
      "Codex sandbox: Workspace write",
      "Codex sandbox: Full access",
      "Approvals: Untrusted",
      "Approvals: On failure",
      "Approvals: On request",
      "Approvals: Never",
    ]);
    expect(
      choices.filter((choice) => choice.current).map((choice) => choice.patch),
    ).toEqual([{ sandbox: "workspace-write" }, { approvals: "on-request" }]);
  });

  it("offers nothing for the built-in agent", () => {
    expect(
      permissionModeChoices(
        agent({ harness: "ai-sdk", harnessPermissions: {} }),
      ),
    ).toEqual([]);
  });
});

describe("agentPermissionView", () => {
  it("lets profile agents change here and keeps definitions read only", () => {
    expect(agentPermissionView({ agent: agent({}) })).toEqual({
      permissionMode: "Bypass permissions",
      sandboxing: "Publish",
      editable: true,
    });
    expect(
      agentPermissionView({
        agent: agent({
          id: "project:p:reviewer",
          sandboxing: "contained",
          harnessPermissions: { permissionMode: "plan" },
        }),
      }),
    ).toMatchObject({
      permissionMode: "Plan",
      sandboxing: "Contained",
      editable: false,
    });
  });

  it("shows only what a server's definition declares", () => {
    expect(
      agentPermissionView({
        agent: undefined,
        remote: {
          sandboxing: "propose",
          harnessPermissions: { approvals: "never" },
        },
      }),
    ).toMatchObject({
      permissionMode: "Approvals never",
      sandboxing: "Propose",
      editable: false,
    });
    expect(
      agentPermissionView({ agent: undefined, remote: {} }).permissionMode,
    ).toBeNull();
  });
});
