/**
 * What code Work runs by itself may reach (ADR 0277), declared beside the
 * code as `catamorphic.access` in its package.json, the shape an app's
 * access has (ADR 0148). Nothing else leaves: the code runs confined, so
 * this declaration is the whole of its reach, and the person approves it
 * when it grows.
 */
export interface CodeAccess {
  /** Host operations: state, notifications, processes, background. */
  permissions?: string[];
  /** Work's lists it reads and acts on (`chats`, `tabs`, `chips`). */
  lists?: string[];
  /** Project workflows it calls. */
  workflows?: string[];
  /** Hosts it reaches: `api.linear.app`, `*.example.com`, `localhost:11434`. */
  hosts?: string[];
  /** Files and folders outside the project it reads (absolute or `~/`). */
  reads?: string[];
  /** Files and folders it changes: in the project unless absolute or `~/`. */
  writes?: string[];
}

export const CODE_PERMISSIONS = [
  "state",
  "notifications",
  "processes",
  "background",
] as const;

/** Work-specific immutable private workflow address, accepted wherever a workflow name is declared. */
export function privateWorkflowAddress(
  address: string,
): { artifactId: string; revision: number } | null {
  if (!address.startsWith("private:")) return null;
  const match =
    /^private:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d*)$/i.exec(
      address,
    );
  const revision = Number(match?.[2]);
  if (!match?.[1] || !Number.isSafeInteger(revision))
    throw new Error("Use private:<artifactId>:<revision>.");
  return { artifactId: match[1], revision };
}
