/**
 * JSON Schema → TypeScript type text, the rendering half of the generated
 * projections: trigger-kind payload/config types and app-api client types
 * are all emitted through this.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * A pragmatic JSON Schema → TypeScript type-text emitter. Covers the shapes
 * zod v4's `toJSONSchema` produces for JSON-compatible schemas; anything it
 * cannot understand degrades to a safe wide type rather than failing.
 */
export function typeFromJsonSchema(schema: unknown, indent: number): string {
  if (typeof schema === "boolean") return schema ? JSON_VALUE : "never";
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return JSON_VALUE;
  }
  const node = schema as Record<string, Json>;

  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum)) {
    return node.enum.map(literal).join(" | ") || "never";
  }

  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    return variants
      .map((variant) => typeFromJsonSchema(variant, indent))
      .join(" | ");
  }

  const type = node.type;
  if (Array.isArray(type)) {
    return type
      .map((member) => typeFromJsonSchema({ ...node, type: member }, indent))
      .join(" | ");
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = node.items === undefined ? JSON_VALUE : node.items;
      return `Array<${typeFromJsonSchema(items, indent)}>`;
    }
    case "object":
      return objectType(node, indent);
    default:
      return JSON_VALUE;
  }
}

const JSON_VALUE =
  "null | boolean | number | string | { [key: string]: unknown } | unknown[]";

function objectType(node: Record<string, Json>, indent: number): string {
  const properties =
    node.properties &&
    typeof node.properties === "object" &&
    !Array.isArray(node.properties)
      ? (node.properties as Record<string, Json>)
      : undefined;
  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const additional = node.additionalProperties;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(properties ?? {})) {
    const optional = required.has(key) ? "" : "?";
    lines.push(
      `${pad(indent + 1)}${propertyKey(key)}${optional}: ${typeFromJsonSchema(value, indent + 1)};`,
    );
  }
  if (additional !== undefined && additional !== false) {
    const valueType =
      additional === true ? JSON_VALUE : typeFromJsonSchema(additional, indent);
    lines.push(`${pad(indent + 1)}[key: string]: ${valueType};`);
  }
  if (lines.length === 0) {
    return additional === false ? "Record<string, never>" : JSON_VALUE;
  }
  return `{\n${lines.join("\n")}\n${pad(indent)}}`;
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return JSON_VALUE;
  return JSON.stringify(value);
}

function pad(indent: number): string {
  return "  ".repeat(indent);
}
