import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  CODEX_APPROVAL_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  declaredPermissionModeLabel,
  effectiveHarnessPermissions,
  type HarnessPermissions,
  permissionModeLabel,
  type Sandboxing,
  sandboxingLabel,
} from "../../shared/agent-permissions.js";
import type { AgentInfo } from "./desktop-api.js";

/** How a chat shows its agent's permission mode and sandboxing (ADR 0182). */
export interface AgentPermissionView {
  /** The harness's own permission mode; null when it has none to show. */
  permissionMode: string | null;
  sandboxing: string | null;
  /** Only profile agents change here; definitions change in their files. */
  editable: boolean;
  readOnlyReason?: string;
}

/** One row of the palette's permission-mode picker. */
export interface PermissionModeChoice {
  id: string;
  label: string;
  detail: string;
  keywords: string[];
  current: boolean;
  /** Merged over the agent's settings when picked. */
  patch: HarnessPermissions;
}

/**
 * The permission-mode picker for one agent, in its harness's own names:
 * Claude Code's modes, or Codex's sandbox then approvals. Empty for a
 * harness without one.
 */
export function permissionModeChoices(
  agent: AgentInfo | undefined,
): PermissionModeChoice[] {
  if (!agent) return [];
  const effective = effectiveHarnessPermissions({
    harness: agent.harness,
    permissions: agent.harnessPermissions,
  });
  switch (agent.harness) {
    case "claude-code":
      return CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => ({
        id: `claude:${option.value}`,
        label: option.label,
        detail: option.detail,
        keywords: [option.value, "claude", "permission"],
        current: option.value === effective.permissionMode,
        patch: { permissionMode: option.value },
      }));
    case "codex":
      return [
        ...CODEX_SANDBOX_OPTIONS.map((option) => ({
          id: `codex-sandbox:${option.value}`,
          label: `Codex sandbox: ${option.label}`,
          detail: option.detail,
          keywords: [option.value, "sandbox", "codex"],
          current: option.value === effective.sandbox,
          patch: { sandbox: option.value },
        })),
        ...CODEX_APPROVAL_OPTIONS.map((option) => ({
          id: `codex-approvals:${option.value}`,
          label: `Approvals: ${option.label}`,
          detail: option.detail,
          keywords: [option.value, "approvals", "codex"],
          current: option.value === effective.approvals,
          patch: { approvals: option.value },
        })),
      ];
    case "ai-sdk":
      return [];
  }
}

export function agentPermissionView(args: {
  agent: AgentInfo | undefined;
  /** A server's agent, from its catalog: only what its definition says. */
  remote?: {
    sandboxing?: Sandboxing;
    harnessPermissions?: HarnessPermissions;
  };
}): AgentPermissionView {
  if (args.remote) {
    return {
      permissionMode: declaredPermissionModeLabel(
        args.remote.harnessPermissions,
      ),
      sandboxing: args.remote.sandboxing
        ? sandboxingLabel(args.remote.sandboxing)
        : null,
      editable: false,
      readOnlyReason: "Set in this agent's definition on the project's server.",
    };
  }
  const agent = args.agent;
  if (!agent)
    return { permissionMode: null, sandboxing: null, editable: false };
  const project = agent.id.startsWith("project:");
  return {
    permissionMode: permissionModeLabel({
      harness: agent.harness,
      permissions: agent.harnessPermissions,
    }),
    sandboxing: sandboxingLabel(agent.sandboxing),
    editable: !project,
    ...(project
      ? {
          readOnlyReason:
            "Set in the project's agent definition in .work/agents.",
        }
      : {}),
  };
}
