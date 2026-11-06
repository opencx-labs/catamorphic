/**
 * The project permissions Catamorphic enforces (ADR 0158). Each names a
 * thing and an action: `read` sees it, `write` changes it (and reads it),
 * `publish` makes program changes live for everyone (and reads them). A
 * role grants them in `permissions`; a workflow declares the ones its runs
 * need, and a run gets only what it declared.
 */
export const PROJECT_PERMISSIONS = [
  /** The project's source: working copy, history, every definition. */
  "program:read",
  /** Edit the working copy: files, branches, commits, app builds. */
  "program:write",
  /** Make program changes live: publish, sync, app versions, proposals. */
  "program:publish",
  /** Which secrets exist (names, never values). */
  "secrets:read",
  /** Set and delete secret values. */
  "secrets:write",
  /** The project's automations. */
  "automations:read",
  /** Turn project automations on, pause them, update them. */
  "automations:write",
  /** Webhook URLs, which are credentials. */
  "webhooks:read",
  /** Replace webhook URLs. */
  "webhooks:write",
  /** Everyone's runs. */
  "runs:read",
  /** Cancel, pause, resume and signal anyone's runs. */
  "runs:write",
  /** Everyone's chats. */
  "sessions:read",
  /** Act on anyone's chat: deliver, interrupt, archive. */
  "sessions:write",
  /** The project's members. */
  "memberships:read",
  /** Invite, grant and revoke members. */
  "memberships:write",
  /** The project's roles. */
  "roles:read",
  /** Change role files and assign roles that carry permissions. */
  "roles:write",
  /** Everyone's publications. */
  "publications:read",
  /** Revoke anyone's publication. */
  "publications:write",
] as const;

export type ProjectPermissionName = (typeof PROJECT_PERMISSIONS)[number];

/**
 * A permission a workflow may declare: one Catamorphic enforces, or a host's
 * own namespaced capability (`acme:approve_deals`).
 */
export type WorkflowPermission =
  | ProjectPermissionName
  | (`${string}:${string}` & {});
