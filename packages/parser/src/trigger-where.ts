/**
 * Trigger `where` filters (ADR 0171): the declarative predicate every
 * binding and every project trigger kind may carry. Pure functions over
 * JSON, shared by project checking and the host's control plane, which
 * evaluates filters before a run starts without running project code.
 *
 * A filter mirrors the payload. A leaf is a JSON primitive (equality), an
 * array of primitives (one of), `{ exists: boolean }`, or `{ prefix: string }`
 * (a string value that starts with it); any other object descends. Keys
 * under `headers` match case-insensitively.
 */

type Primitive = string | number | boolean | null;

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existsLeaf(value: Record<string, unknown>): boolean | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 &&
    keys[0] === "exists" &&
    typeof value.exists === "boolean"
    ? value.exists
    : undefined;
}

function prefixLeaf(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 &&
    keys[0] === "prefix" &&
    typeof value.prefix === "string"
    ? value.prefix
    : undefined;
}

/** Why `value` is not a valid filter; empty when it is. */
export function whereErrors(value: unknown, path = "where"): string[] {
  if (isPrimitive(value)) return [];
  if (Array.isArray(value)) {
    return value.every(isPrimitive)
      ? []
      : [
          `${path} lists values to match; each must be a string, number, boolean or null`,
        ];
  }
  if (!isRecord(value)) return [`${path} must be a JSON value`];
  if (existsLeaf(value) !== undefined) return [];
  const prefix = prefixLeaf(value);
  if (prefix !== undefined)
    return prefix === ""
      ? [`${path}.prefix must not be empty; leave the position out instead`]
      : [];
  return Object.entries(value).flatMap(([key, child]) =>
    whereErrors(child, `${path}.${key}`),
  );
}

/** Whether `value` satisfies `where`. */
export function matchesWhere(where: unknown, value: unknown): boolean {
  return matches(where, value, false);
}

/** Whether `value` satisfies every filter in `filters` (none always does). */
export function matchesAllWhere(
  filters: readonly unknown[],
  value: unknown,
): boolean {
  return filters.every((where) => matchesWhere(where, value));
}

function matches(where: unknown, value: unknown, headers: boolean): boolean {
  if (isPrimitive(where)) return value === where;
  if (Array.isArray(where)) return where.some((option) => value === option);
  if (!isRecord(where)) return false;
  const exists = existsLeaf(where);
  if (exists !== undefined)
    return exists === (value !== undefined && value !== null);
  const prefix = prefixLeaf(where);
  if (prefix !== undefined)
    return typeof value === "string" && value.startsWith(prefix);
  if (!isRecord(value)) return false;
  return Object.entries(where).every(([key, child]) =>
    matches(
      child,
      lookup(value, key, headers),
      key.toLowerCase() === "headers",
    ),
  );
}

function lookup(
  object: Record<string, unknown>,
  key: string,
  caseInsensitive: boolean,
): unknown {
  if (Object.hasOwn(object, key)) return object[key];
  if (!caseInsensitive) return undefined;
  const wanted = key.toLowerCase();
  const match = Object.keys(object).find(
    (candidate) => candidate.toLowerCase() === wanted,
  );
  return match === undefined ? undefined : object[match];
}
