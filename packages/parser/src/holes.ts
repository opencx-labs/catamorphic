/**
 * Schema-side support for typed holes in trigger-kind templates (ADR 0042).
 *
 * A parameterized kind marks open positions of its payload JSON Schema with
 * `"x-catamorphic-hole": "<Name>"` (the server-sdk's `hole()` helper emits
 * the marker; `typeFromJsonSchema` renders it as `Hole<"Name">`). Each bound
 * workflow instantiates a hole with its own input type, so the derived
 * per-binding input schema is the hole's frozen, tool-definition-ready
 * schema. These utilities let scan-time validation fail closed when a hole
 * would freeze to nothing.
 */

/** JSON Schema extension key marking a hole in a kind's template. */
export const HOLE_SCHEMA_KEY = "x-catamorphic-hole";

export interface SchemaHole {
  name: string;
  /**
   * Data path from the payload root to the hole: property names, with
   * `"[]"` for array items — e.g. `["body"]` or `["items", "[]"]`.
   */
  path: readonly string[];
  /**
   * Holes are supported only in plain object-property / array-item
   * positions, where a single data path into the workflow's derived schema
   * exists. A hole under `anyOf`/`oneOf`/`allOf`, `additionalProperties`,
   * or `prefixItems` still renders in the generated types but cannot be
   * resolved deterministically — kind registration rejects it.
   */
  supported: boolean;
}

/** All holes declared in a kind's template schema, in document order. */
export function schemaHoles(schema: unknown): SchemaHole[] {
  const holes: SchemaHole[] = [];
  walk(schema, [], true, holes);
  return holes;
}

function walk(
  schema: unknown,
  path: string[],
  supported: boolean,
  holes: SchemaHole[],
): void {
  if (schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    // Union arms / prefixItems entries: positions without a single data path.
    for (const entry of schema) walk(entry, path, false, holes);
    return;
  }
  const node = schema as Record<string, unknown>;
  const name = node[HOLE_SCHEMA_KEY];
  if (typeof name === "string") {
    holes.push({ name, path: [...path], supported });
    return;
  }
  const properties = node.properties;
  if (properties && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties)) {
      walk(value, [...path, key], supported, holes);
    }
  }
  if (node.items !== undefined) {
    walk(node.items, [...path, "[]"], supported, holes);
  }
  for (const combinator of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (node[combinator] !== undefined) walk(node[combinator], path, false, holes);
  }
  if (
    node.additionalProperties !== undefined &&
    typeof node.additionalProperties === "object"
  ) {
    walk(node.additionalProperties, path, false, holes);
  }
  if (node.not !== undefined) walk(node.not, path, false, holes);
}

/**
 * Resolves a hole's data path inside a derived workflow schema. Returns
 * `undefined` when the schema does not declare the position at all.
 */
export function resolveSchemaPath(
  schema: unknown,
  path: readonly string[],
): unknown {
  let current: unknown = schema;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    const node = current as Record<string, unknown>;
    if (segment === "[]") {
      current = node.items;
    } else {
      const properties = node.properties;
      current =
        properties && typeof properties === "object"
          ? (properties as Record<string, unknown>)[segment]
          : undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Whether a schema accepts anything — the extractor's `{}` degradation or
 * an equivalent. A hole frozen to a permissive schema is an authoring
 * error: the tool/endpoint it feeds would advertise an unknowable shape.
 */
export function isPermissiveSchema(schema: unknown): boolean {
  if (schema === true) return true;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return true;
  }
  const constraining = [
    "type",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "properties",
    "required",
    "items",
    "additionalProperties",
  ];
  return !constraining.some((key) => key in (schema as object));
}

/**
 * Registration-time template validation: every hole must sit in a
 * supported position. Returns human-readable errors; empty means valid.
 */
export function unsupportedHoleErrors(schema: unknown): string[] {
  return schemaHoles(schema)
    .filter((hole) => !hole.supported)
    .map(
      (hole) =>
        `hole '${hole.name}' sits in an unsupported position (union/allOf/additionalProperties/prefixItems); holes must be plain object properties or array items`,
    );
}

/**
 * Deploy-time hole validation for one binding: every hole in the kind's
 * payload template must resolve to a concrete schema inside the workflow's
 * derived input schema. Returns human-readable errors; empty means valid.
 */
export function holeSchemaErrors(args: {
  payloadSchema: unknown;
  inputSchema: unknown;
}): string[] {
  const errors: string[] = [];
  for (const hole of schemaHoles(args.payloadSchema)) {
    const where =
      hole.path.length > 0 ? ` at payload path '${hole.path.join(".")}'` : "";
    if (!hole.supported) {
      errors.push(
        `hole '${hole.name}'${where} sits in an unsupported schema position — holes must be plain object properties or array items`,
      );
      continue;
    }
    const resolved = resolveSchemaPath(args.inputSchema, hole.path);
    if (resolved === undefined) {
      errors.push(
        `hole '${hole.name}'${where} is not declared by the workflow input type`,
      );
    } else if (isPermissiveSchema(resolved)) {
      errors.push(
        `hole '${hole.name}'${where} derives a permissive schema — give the workflow input a concrete type there so the hole has a real schema`,
      );
    }
  }
  return errors;
}
