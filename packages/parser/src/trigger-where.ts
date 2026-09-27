/**
 * Trigger `where` filters (ADR 0171): the declarative predicate every
 * binding and every project trigger kind may carry. Pure functions over
 * JSON, shared by project checking and the host's control plane, which
 * evaluates filters before a run starts without running project code.
 *
 * A filter mirrors the payload. A leaf is a JSON primitive (equality), an
 * array of primitives (one of), `{ $exists: boolean }`, or
 * `{ $prefix: string }` (a string value that starts with it); any other
 * object descends. Keys starting with `$` are operators, so a payload field
 * named `exists` or `prefix` still matches by equality. Keys under
 * `headers` match case-insensitively.
 */

type Primitive = string | number | boolean | null;

/** The operator keys a filter object may hold, each on its own. */
const OPERATORS = ["$exists", "$prefix"] as const;

type Operator =
  | { kind: "exists"; exists: boolean }
  | { kind: "prefix"; prefix: string };

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

function isOperatorKey(key: string): boolean {
  return key.startsWith("$");
}

/** The operator `value` states, when it is a well-formed operator object. */
function operatorOf(value: Record<string, unknown>): Operator | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "$exists" && typeof value.$exists === "boolean")
    return { kind: "exists", exists: value.$exists };
  if (keys[0] === "$prefix" && typeof value.$prefix === "string")
    return { kind: "prefix", prefix: value.$prefix };
  return undefined;
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
  const keys = Object.keys(value);
  if (keys.some(isOperatorKey)) {
    const operator = operatorOf(value);
    if (operator?.kind === "exists") return [];
    if (operator?.kind === "prefix")
      return operator.prefix === ""
        ? [`${path}.$prefix must not be empty; leave the position out instead`]
        : [];
    const unknown = keys.find(
      (key) =>
        isOperatorKey(key) && !OPERATORS.some((operator) => operator === key),
    );
    if (unknown)
      return [
        `${path}.${unknown} is not an operator; use $exists or $prefix`,
      ];
    if (keys.length > 1)
      return [`${path} must hold one operator alone, without other keys`];
    return keys[0] === "$exists"
      ? [`${path}.$exists must be true or false`]
      : [`${path}.$prefix must be a string`];
  }
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
  if (Object.keys(where).some(isOperatorKey)) {
    // A malformed operator never matches: filters fail closed.
    const operator = operatorOf(where);
    if (operator?.kind === "exists")
      return operator.exists === (value !== undefined && value !== null);
    if (operator?.kind === "prefix")
      return typeof value === "string" && value.startsWith(operator.prefix);
    return false;
  }
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
