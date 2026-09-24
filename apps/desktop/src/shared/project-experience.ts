/**
 * Project-authored presentation targeting. This is deliberately expressed in
 * resolved authority, not role names: roles are a policy input, while these
 * are the facts every host can return for the current caller.
 */
export interface ProjectExperienceWhen {
  /** Every listed project permission must be held (ADR 0158). */
  permissions?: string[];
}

export interface ProjectExperienceContext {
  /** Root is host authority and therefore satisfies every project predicate. */
  root: boolean;
  /** Held permissions as `GET /me` reports them: implications expanded. */
  permissions: readonly string[];
}

/**
 * Whether a remote member works on the program itself, in a Git checkout of
 * it (`program:write`). Everyone else syncs the project's files read-only.
 */
export function writesProgram(
  capabilities: { permissions: readonly string[] } | null | undefined,
): boolean {
  return capabilities?.permissions.includes("program:write") ?? false;
}

const PERMISSION_NAME = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;

/**
 * Sanitize data crossing a project-owned config boundary. `null` means an
 * explicitly present predicate was invalid and the owning item must disappear
 * rather than accidentally becoming visible to everyone.
 */
export function sanitizeProjectExperienceWhen(
  value: unknown,
): ProjectExperienceWhen | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "permissions")) {
    return null;
  }
  if (
    value.permissions !== undefined &&
    (!Array.isArray(value.permissions) ||
      value.permissions.some(
        (permission) =>
          typeof permission !== "string" || !PERMISSION_NAME.test(permission),
      ))
  ) {
    return null;
  }
  return {
    ...(Array.isArray(value.permissions)
      ? { permissions: [...new Set(value.permissions)] }
      : {}),
  };
}

export function matchesProjectExperience(
  when: ProjectExperienceWhen | undefined,
  context: ProjectExperienceContext,
): boolean {
  if (!when || context.root) return true;
  const available = new Set(context.permissions);
  return (when.permissions ?? []).every((permission) =>
    available.has(permission),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
