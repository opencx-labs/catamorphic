/**
 * The two agent settings people confuse, kept apart (ADR 0182):
 *
 * - **Sandboxing** is Work's: what may leave the agent's sandbox. On this
 *   machine a local agent's project folder is its sandbox; sandboxing
 *   governs what it sends onward (host tools, connections, proposals,
 *   deploys and publications).
 * - **Permission mode** is the harness's own, in its native names: Claude
 *   Code's permission mode, Codex's sandbox and approvals. The built-in
 *   agent has none (its tool policies cover the same ground).
 *
 * Renderer-safe mirror of `@catamorphic/sandbox`'s values; a main-process
 * test keeps the two in step.
 */

export type AgentHarnessKind = "ai-sdk" | "claude-code" | "codex";

export type Sandboxing = "contained" | "propose" | "publish";
export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";
export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

/** A harness's own permission settings; which fields apply depends on it. */
export interface HarnessPermissions {
  permissionMode?: ClaudeCodePermissionMode;
  sandbox?: CodexSandboxMode;
  approvals?: CodexApprovalPolicy;
}

export interface SettingOption<T extends string> {
  value: T;
  label: string;
  detail: string;
}

export const SANDBOXING_OPTIONS: SettingOption<Sandboxing>[] = [
  {
    value: "contained",
    label: "Contained",
    detail:
      "Works freely in its own space. Nothing it does leaves: no host tools that act for you, connections only read, no proposals or publishing.",
  },
  {
    value: "propose",
    label: "Propose",
    detail:
      "May use its tools and connections and propose changes, but never deploys or publishes.",
  },
  {
    value: "publish",
    label: "Publish",
    detail:
      "Everything its connections and roles allow, including deploying and publishing. The local default.",
  },
];

export const CLAUDE_PERMISSION_MODE_OPTIONS: SettingOption<ClaudeCodePermissionMode>[] =
  [
    {
      value: "default",
      label: "Default",
      detail: "Asks before edits and commands.",
    },
    {
      value: "acceptEdits",
      label: "Accept edits",
      detail: "File edits land without asking; commands still ask.",
    },
    {
      value: "plan",
      label: "Plan",
      detail: "Reads and plans. No edits, no commands.",
    },
    {
      value: "auto",
      label: "Auto",
      detail: "A classifier approves or denies each action.",
    },
    {
      value: "dontAsk",
      label: "Don't ask",
      detail: "Never asks. Anything not already allowed is denied.",
    },
    {
      value: "bypassPermissions",
      label: "Bypass permissions",
      detail: "Runs every tool without asking. The local default.",
    },
  ];

export const CODEX_SANDBOX_OPTIONS: SettingOption<CodexSandboxMode>[] = [
  {
    value: "read-only",
    label: "Read only",
    detail: "Reads files. No edits.",
  },
  {
    value: "workspace-write",
    label: "Workspace write",
    detail: "Edits the working folder; everything else stays read only.",
  },
  {
    value: "danger-full-access",
    label: "Full access",
    detail: "No Codex sandbox. The local default.",
  },
];

export const CODEX_APPROVAL_OPTIONS: SettingOption<CodexApprovalPolicy>[] = [
  {
    value: "untrusted",
    label: "Untrusted",
    detail: "Asks before anything but known safe reads.",
  },
  {
    value: "on-failure",
    label: "On failure",
    detail: "Asks only when a sandboxed command fails.",
  },
  {
    value: "on-request",
    label: "On request",
    detail: "Codex decides when to ask. The local default.",
  },
  { value: "never", label: "Never", detail: "Never asks." },
];

/** Local agents default to full freedom (ADR 0140). */
export const DESKTOP_DEFAULT_SANDBOXING: Sandboxing = "publish";
export const DESKTOP_HARNESS_DEFAULTS = {
  permissionMode: "bypassPermissions",
  sandbox: "danger-full-access",
  approvals: "on-request",
} as const satisfies Required<HarnessPermissions>;

/** Whether this harness has a permission mode of its own. */
export function hasPermissionMode(harness: AgentHarnessKind): boolean {
  return harness === "claude-code" || harness === "codex";
}

/**
 * The permission settings a harness runs with: the chosen values, else the
 * local defaults, holding only the fields this harness has.
 */
export function effectiveHarnessPermissions(args: {
  harness: AgentHarnessKind;
  permissions: HarnessPermissions | undefined | null;
}): HarnessPermissions {
  const chosen = args.permissions ?? {};
  switch (args.harness) {
    case "claude-code":
      return {
        permissionMode:
          chosen.permissionMode ?? DESKTOP_HARNESS_DEFAULTS.permissionMode,
      };
    case "codex":
      return {
        sandbox: chosen.sandbox ?? DESKTOP_HARNESS_DEFAULTS.sandbox,
        approvals: chosen.approvals ?? DESKTOP_HARNESS_DEFAULTS.approvals,
      };
    case "ai-sdk":
      return {};
  }
}

function labelOf<T extends string>(
  options: SettingOption<T>[],
  value: T | undefined,
): string {
  return options.find((option) => option.value === value)?.label ?? "";
}

/** The permission mode in the harness's own words, or null when it has none. */
export function permissionModeLabel(args: {
  harness: AgentHarnessKind;
  permissions: HarnessPermissions | undefined | null;
}): string | null {
  const effective = effectiveHarnessPermissions(args);
  switch (args.harness) {
    case "claude-code":
      return labelOf(CLAUDE_PERMISSION_MODE_OPTIONS, effective.permissionMode);
    case "codex":
      return `${labelOf(CODEX_SANDBOX_OPTIONS, effective.sandbox)}, approvals ${labelOf(
        CODEX_APPROVAL_OPTIONS,
        effective.approvals,
      ).toLowerCase()}`;
    case "ai-sdk":
      return null;
  }
}

/**
 * What a definition declares, in the harness's own words, without local
 * defaults filled in (another host applies its own); null when it declares
 * nothing.
 */
export function declaredPermissionModeLabel(
  permissions: HarnessPermissions | undefined | null,
): string | null {
  if (!permissions) return null;
  if (permissions.permissionMode)
    return labelOf(CLAUDE_PERMISSION_MODE_OPTIONS, permissions.permissionMode);
  const parts = [
    permissions.sandbox
      ? labelOf(CODEX_SANDBOX_OPTIONS, permissions.sandbox)
      : null,
    permissions.approvals
      ? `approvals ${labelOf(CODEX_APPROVAL_OPTIONS, permissions.approvals).toLowerCase()}`
      : null,
  ].filter((part) => part !== null);
  const label = parts.join(", ");
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : null;
}

export function sandboxingLabel(sandboxing: Sandboxing): string {
  return labelOf(SANDBOXING_OPTIONS, sandboxing);
}
