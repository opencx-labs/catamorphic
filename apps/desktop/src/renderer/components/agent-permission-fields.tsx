import {
  type AgentHarnessKind,
  CLAUDE_PERMISSION_MODE_OPTIONS,
  CODEX_APPROVAL_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  DESKTOP_HARNESS_DEFAULTS,
  type HarnessPermissions,
  type SettingOption,
} from "../../shared/agent-permissions.js";

/** A labelled select over described options, with the chosen one's detail. */
export function SettingSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: SettingOption<T>[];
  value: T;
  onChange: (next: T) => void;
  testId: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      {label}
      <select
        value={value}
        onChange={(event) => {
          const next = options.find(
            (option) => option.value === event.target.value,
          );
          if (next) onChange(next.value);
        }}
        className="field h-8 px-2 text-[13px] text-fg"
        data-testid={testId}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="text-fg-faint">
        {options.find((option) => option.value === value)?.detail}
      </span>
    </label>
  );
}

/**
 * The harness's own permission mode, in its own names (ADR 0182): Claude
 * Code's permission mode, or Codex's sandbox and approvals. Renders nothing
 * for a harness without one. `value` holds the settings in effect.
 */
export function PermissionModeFields({
  harness,
  value,
  onChange,
}: {
  harness: AgentHarnessKind;
  value: HarnessPermissions;
  onChange: (next: HarnessPermissions) => void;
}) {
  if (harness === "claude-code") {
    return (
      <SettingSelect
        label="Permission mode"
        options={CLAUDE_PERMISSION_MODE_OPTIONS}
        value={value.permissionMode ?? DESKTOP_HARNESS_DEFAULTS.permissionMode}
        onChange={(permissionMode) => onChange({ permissionMode })}
        testId="agent-permission-mode"
      />
    );
  }
  if (harness === "codex") {
    return (
      <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-bg-inset/40 p-3">
        <legend className="px-1 text-xs font-medium text-fg-muted">
          Permission mode
        </legend>
        <SettingSelect
          label="Codex sandbox"
          options={CODEX_SANDBOX_OPTIONS}
          value={value.sandbox ?? DESKTOP_HARNESS_DEFAULTS.sandbox}
          onChange={(sandbox) => onChange({ ...value, sandbox })}
          testId="agent-codex-sandbox"
        />
        <SettingSelect
          label="Approvals"
          options={CODEX_APPROVAL_OPTIONS}
          value={value.approvals ?? DESKTOP_HARNESS_DEFAULTS.approvals}
          onChange={(approvals) => onChange({ ...value, approvals })}
          testId="agent-codex-approvals"
        />
      </fieldset>
    );
  }
  return null;
}

export function samePermissions(
  a: HarnessPermissions,
  b: HarnessPermissions,
): boolean {
  return (
    a.permissionMode === b.permissionMode &&
    a.sandbox === b.sandbox &&
    a.approvals === b.approvals
  );
}
