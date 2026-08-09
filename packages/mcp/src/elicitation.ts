/**
 * Elicitation (MCP `elicitation/create`) + MRTR, in harness-neutral form.
 *
 * A server can pause a call to ask the *user* something — a small form, or
 * a URL to open (OAuth and other credential handoffs). The host renders it
 * and returns the answer. On the stateless 2026-07-28 era this rides MRTR
 * (`input_required` results); the official v2 client auto-fulfils those
 * rounds through the SAME `elicitation/create` handler, so registering one
 * handler covers both eras — that IS the MRTR implementation here.
 *
 * These types flatten the spec's restricted-JSON-Schema form into a field
 * list the host can render without knowing MCP, and the answer back into a
 * plain accept/decline/cancel.
 */

export type ElicitFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum";

export interface ElicitFormField {
  name: string;
  type: ElicitFieldType;
  title?: string;
  description?: string;
  required: boolean;
  /** string only: email | uri | date | date-time (spec formats). */
  format?: string;
  default?: string | number | boolean;
  /** enum only: allowed values with display labels. */
  options?: Array<{ value: string; label: string }>;
  /** enum only: multiple selections allowed. */
  multiSelect?: boolean;
}

export type ElicitRequest =
  | { mode: "form"; message: string; fields: ElicitFormField[] }
  | { mode: "url"; message: string; url: string };

export type ElicitResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** How a host answers an elicitation. Returning `cancel` is always safe. */
export type ElicitHandler = (request: ElicitRequest) => Promise<ElicitResult>;

/**
 * Parse the SDK's `elicitation/create` params into a neutral request.
 * Returns null for shapes the host can't render (the caller declines).
 */
export function parseElicitRequest(params: unknown): ElicitRequest | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const message =
    typeof record.message === "string" ? record.message : "Input requested";
  // URL mode: an explicit url, or mode === "url".
  if (record.mode === "url" || typeof record.url === "string") {
    const url = typeof record.url === "string" ? record.url : "";
    if (!/^https:\/\//i.test(url)) return null;
    return { mode: "url", message, url };
  }
  const schema = record.requestedSchema;
  const fields = parseFormFields(schema);
  return { mode: "form", message, fields };
}

interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  default?: unknown;
  enum?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
  anyOf?: Array<{ const?: unknown; title?: string }>;
  items?: {
    enum?: unknown[];
    anyOf?: Array<{ const?: unknown; title?: string }>;
  };
}

function parseFormFields(schema: unknown): ElicitFormField[] {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as {
    properties?: Record<string, JsonSchemaProperty>;
    required?: unknown[];
  };
  const properties = record.properties ?? {};
  const required = new Set(
    (record.required ?? []).filter(
      (name): name is string => typeof name === "string",
    ),
  );
  const fields: ElicitFormField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const field = parseFormField(name, property, required.has(name));
    if (field) fields.push(field);
  }
  return fields;
}

function parseFormField(
  name: string,
  property: JsonSchemaProperty,
  required: boolean,
): ElicitFormField | null {
  const base = {
    name,
    title: property.title,
    description: property.description,
    required,
  };
  // Multi-select: array of enum values.
  if (property.type === "array") {
    const options = enumOptions(
      property.items?.enum,
      property.items?.anyOf ?? undefined,
    );
    if (options.length === 0) return null;
    return { ...base, type: "enum", multiSelect: true, options };
  }
  // Single-select enum: `enum`, or `oneOf`/`anyOf` of consts.
  const options = enumOptions(property.enum, property.oneOf ?? property.anyOf);
  if (options.length > 0) {
    return {
      ...base,
      type: "enum",
      options,
      ...(typeof property.default === "string"
        ? { default: property.default }
        : {}),
    };
  }
  switch (property.type) {
    case "boolean":
      return {
        ...base,
        type: "boolean",
        ...(typeof property.default === "boolean"
          ? { default: property.default }
          : {}),
      };
    case "number":
    case "integer":
      return {
        ...base,
        type: property.type,
        ...(typeof property.default === "number"
          ? { default: property.default }
          : {}),
      };
    default:
      return {
        ...base,
        type: "string",
        ...(property.format ? { format: property.format } : {}),
        ...(typeof property.default === "string"
          ? { default: property.default }
          : {}),
      };
  }
}

function enumOptions(
  values: unknown[] | undefined,
  labeled: Array<{ const?: unknown; title?: string }> | undefined,
): Array<{ value: string; label: string }> {
  if (Array.isArray(labeled) && labeled.some((entry) => "const" in entry)) {
    return labeled
      .filter((entry) => entry.const !== undefined)
      .map((entry) => ({
        value: String(entry.const),
        label: entry.title ?? String(entry.const),
      }));
  }
  if (Array.isArray(values)) {
    return values.map((value) => ({
      value: String(value),
      label: String(value),
    }));
  }
  return [];
}
