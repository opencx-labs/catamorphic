/** Catamorphic's project permissions in plain words (ADR 0158). */
const PERMISSION_WORDS: Record<string, string> = {
  "program:read": "Read the project's source",
  "program:write": "Edit the project's source",
  "program:publish": "Publish changes to the project",
  "secrets:read": "See which secrets exist",
  "secrets:write": "Set and delete secrets",
  "automations:read": "See the project's automations",
  "automations:write": "Turn project automations on and off",
  "webhooks:read": "See webhook addresses",
  "webhooks:write": "Replace webhook addresses",
  "runs:read": "See everyone's runs",
  "runs:write": "Stop, pause and resume anyone's runs",
  "sessions:read": "Read everyone's chats",
  "sessions:write": "Post into anyone's chat",
  "memberships:read": "See the project's members",
  "memberships:write": "Invite and remove members",
  "roles:read": "See the project's roles",
  "roles:write": "Change the project's roles",
  "publications:read": "See everyone's publications",
  "publications:write": "Revoke anyone's publication",
};

export function describeProjectPermission(permission: string): string {
  return PERMISSION_WORDS[permission] ?? permission;
}

const SUSPENSION_WORDS: Record<string, string> = {
  member_removed: "Paused: its owner is no longer in the project.",
  workflow_denied: "Paused: its owner can no longer run this workflow.",
  environment_denied: "Paused: its owner can no longer use this environment.",
  connection_unavailable: "Paused: a connection it uses is unavailable.",
  connection_permission_denied:
    "Paused: a connection it uses no longer allows it.",
  connection_capability_changed:
    "Paused: a connection's allowed actions changed. Review to resume.",
  permission_revoked:
    "Paused: its owner no longer holds a permission this workflow needs.",
  expired: "Ended: it reached its expiry.",
};

export function describeAutomationPause(reason: string): string {
  return SUSPENSION_WORDS[reason] ?? `Paused: ${reason.replaceAll("_", " ")}.`;
}
