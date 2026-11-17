import { createHash } from "node:crypto";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { z } from "zod";

/*
 * Typed results (ADR 0323): a committed agent definition names the values
 * its agent submits with `submit_result`, each by a JSON Schema. The
 * schemas are checked when the definition loads; a value is checked when
 * the agent submits it, and only an accepted value is recorded.
 */

/** A result's name: lowercase, as `review` or `vote`. */
export const RESULT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const RESULT_LIMITS = {
  /** Names one definition may declare. */
  names: 16,
  /** All of a definition's schemas, as JSON. */
  schemaBytes: 64 * 1024,
  /** One submitted value, as JSON. */
  valueBytes: 256 * 1024,
  /** Results one chat may record. */
  perSession: 1_000,
  /** Field errors one rejected submission reports. */
  errors: 20,
} as const;

/** The schemas a definition declares, by result name. */
export type ResultSchemas = Readonly<Record<string, JsonSchemaObject>>;
type JsonSchemaObject = { [key: string]: JsonValue } | boolean;

/** One reason a value does not match its schema. */
export interface ResultFieldError {
  /** JSON Pointer of the field (`/comments/0/line`); empty for the value itself. */
  path: string;
  message: string;
}

/** The `results` field of an agent definition. */
export const ResultSchemasSchema = z
  .record(z.string(), z.union([z.boolean(), z.record(z.string(), z.json())]))
  .superRefine((results, ctx) => {
    const names = Object.keys(results);
    for (const name of names)
      if (!RESULT_NAME_PATTERN.test(name))
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `Result name "${name}" must be lowercase letters, digits, "-" and "_", starting with a letter`,
        });
    if (names.length > RESULT_LIMITS.names)
      ctx.addIssue({
        code: "custom",
        message: `An agent declares at most ${RESULT_LIMITS.names} results`,
      });
    if (jsonBytes(results) > RESULT_LIMITS.schemaBytes)
      ctx.addIssue({
        code: "custom",
        message: `Result schemas total at most ${RESULT_LIMITS.schemaBytes / 1024} KiB of JSON`,
      });
    for (const name of names) {
      if (!RESULT_NAME_PATTERN.test(name)) continue;
      const problem = schemaProblem(results[name] ?? true);
      if (problem)
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `Not a usable JSON Schema (2020-12): ${problem}`,
        });
    }
  });

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  // Formats would need ajv-formats; an unknown one is accepted unchecked.
  validateFormats: false,
  strict: "log",
  logger: false,
});

/** Compiled validators by the schema's digest: definitions reload often. */
const compiled = new Map<string, ValidateFunction>();

function validatorFor(schema: JsonSchemaObject): ValidateFunction {
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const known = compiled.get(key);
  if (known) return known;
  const validate = ajv.compile(schema);
  if (compiled.size >= 512) compiled.clear();
  compiled.set(key, validate);
  return validate;
}

function schemaProblem(schema: JsonSchemaObject): string | undefined {
  try {
    validatorFor(schema);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function fieldErrors(
  errors: readonly ErrorObject[] | null | undefined,
): ResultFieldError[] {
  return (errors ?? []).slice(0, RESULT_LIMITS.errors).map((error) => {
    const extra =
      error.keyword === "additionalProperties" &&
      typeof error.params.additionalProperty === "string"
        ? `: ${error.params.additionalProperty}`
        : error.keyword === "enum" && Array.isArray(error.params.allowedValues)
          ? `: ${error.params.allowedValues.map((value: unknown) => JSON.stringify(value)).join(", ")}`
          : "";
    return {
      path: error.instancePath,
      message: `${error.message ?? `fails ${error.keyword}`}${extra}`,
    };
  });
}

/**
 * Check a submitted value against its schema. A string that does not
 * match but decodes once as JSON to a value that does is accepted decoded:
 * models often send objects and arrays as JSON text.
 */
export function checkResultValue(input: {
  schema: JsonSchemaObject;
  value: unknown;
}): { value: JsonValue } | { errors: ResultFieldError[] } {
  const validate = validatorFor(input.schema);
  const asJson = (value: unknown): JsonValue | undefined => {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : (JSON.parse(text) as JsonValue);
  };
  const value = asJson(input.value);
  if (value === undefined)
    return { errors: [{ path: "", message: "must be a JSON value" }] };
  if (validate(value)) return { value };
  const errors = fieldErrors(validate.errors);
  if (typeof value === "string") {
    const decoded = decodeOnce(value);
    if (decoded !== undefined && validate(decoded)) return { value: decoded };
  }
  return { errors };
}

function decodeOnce(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Whether a value fits the per-result bound, as JSON. */
export function resultValueFits(value: JsonValue): boolean {
  return jsonBytes(value) <= RESULT_LIMITS.valueBytes;
}

/** The tool's description: what it does, and each result's schema. */
export function submitResultDescription(schemas: ResultSchemas): string {
  const names = Object.keys(schemas).sort();
  return [
    "Submit a result your definition declares. Only an accepted result counts: whoever reads your work (a workflow, the session that started you) reads results, not your messages. The value must match the result's JSON Schema; a rejected call records nothing and lists each failing field, so correct those fields and call again. Pass value as JSON, not as text. Submit again whenever a later message changes your answer: the newest result answers the newest input.",
    "Results:",
    ...names.map((name) => `- ${name}: ${JSON.stringify(schemas[name])}`),
  ].join("\n");
}

export const submitResultInputSchema = z.object({
  name: z.string().min(1).describe("The result's name"),
  // Any JSON: the named schema decides, and its errors say what to fix.
  value: z.unknown().describe("The value, matching that result's JSON Schema"),
});
