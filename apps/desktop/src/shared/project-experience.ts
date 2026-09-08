/**
 * Project-authored presentation targeting. This is deliberately expressed in
 * resolved authority, not role names: roles are a policy input, while these
 * are the facts every host can return for the current caller.
 */
export interface ProjectExperienceWhen {
  /** Present only when the caller's builder state equals this value. */
  builder?: boolean;
  /** Every listed namespaced project permission must be present. */
  permissions?: string[];
}

export interface ProjectExperienceContext {
  /** Root is host authority and therefore satisfies every project predicate. */
  root: boolean;
  builder: boolean;
  permissions: readonly string[];
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
  if (
    Object.keys(value).some((key) => !["builder", "permissions"].includes(key))
  ) {
    return null;
  }
  if (value.builder !== undefined && typeof value.builder !== "boolean") {
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
    ...(typeof value.builder === "boolean" ? { builder: value.builder } : {}),
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
  if (when.builder !== undefined && when.builder !== context.builder) {
    return false;
  }
  const available = new Set(context.permissions);
  return (when.permissions ?? []).every((permission) =>
    available.has(permission),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
