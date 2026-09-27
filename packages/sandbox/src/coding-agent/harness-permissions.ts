/**
 * A harness's own permission mode (ADR 0182), in the harness's native values.
 * It governs what the harness does without asking inside the place it runs.
 * It is independent of sandboxing, which governs what leaves an agent's
 * sandbox: Claude Code in `bypassPermissions` inside a `contained` sandbox is
 * fast inside and changes nothing outside.
 */

/** Claude Code's permission modes, as its SDK names them. */
export const CLAUDE_CODE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;
export type ClaudeCodePermissionMode =
  (typeof CLAUDE_CODE_PERMISSION_MODES)[number];

/** Codex's own OS sandbox, as its SDK names it. */
export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** When Codex asks before acting, as its SDK names it. */
export const CODEX_APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

/**
 * The permission settings an agent chooses for its harness. Which fields
 * apply depends on the harness: Claude Code takes `permissionMode`; Codex
 * takes `sandbox` and `approvals`; the built-in agent takes none (its tool
 * policies cover the same ground). Absent fields keep the host's default.
 */
export interface HarnessPermissions {
  /** Claude Code's permission mode. */
  permissionMode?: ClaudeCodePermissionMode;
  /** Codex's own sandbox. */
  sandbox?: CodexSandboxMode;
  /** Codex's approval policy. */
  approvals?: CodexApprovalPolicy;
}

const HARNESS_PERMISSION_FIELDS: Record<
  string,
  readonly (keyof HarnessPermissions)[]
> = {
  "claude-code": ["permissionMode"],
  codex: ["sandbox", "approvals"],
};

/**
 * The fields of `permissions` that `kind` does not take, with a readable
 * message; empty when every set field applies to the harness.
 */
export function harnessPermissionIssues(args: {
  kind: string;
  permissions: HarnessPermissions;
}): { field: keyof HarnessPermissions; message: string }[] {
  const allowed = HARNESS_PERMISSION_FIELDS[args.kind] ?? [];
  const fields: (keyof HarnessPermissions)[] = [
    "permissionMode",
    "sandbox",
    "approvals",
  ];
  return fields
    .filter(
      (field) => args.permissions[field] !== undefined && !allowed.includes(field),
    )
    .map((field) => ({
      field,
      message:
        allowed.length === 0
          ? `A ${args.kind} agent has no harness permission settings; remove '${field}'`
          : `A ${args.kind} agent takes ${allowed.map((name) => `'${name}'`).join(" and ")}, not '${field}'`,
    }));
}
