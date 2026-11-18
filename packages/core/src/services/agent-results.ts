import { createHash } from "node:crypto";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { RE2JS } from "re2js";
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
  /**
   * Results one turn may record. Per turn, not per chat (ADR 0336): a review
   * chat lives as long as its pull request, and its results grow with its
   * turns like the rest of its log.
   */
  perTurn: 1_000,
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

/**
 * An Ajv of its own for every schema: a schema's `$id` registers in the
 * instance that compiles it, so a shared one would refuse a definition
 * edited with the same `$id`, and let two projects' schemas collide or
 * resolve each other's `$ref`.
 */
function compileSchema(schema: JsonSchemaObject): ValidateFunction {
  return new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    // Formats would need ajv-formats; an unknown one is accepted unchecked.
    validateFormats: false,
    strict: "log",
    logger: false,
    code: { regExp: linearRegExp },
  }).compile(schema);
}

/** The longest `pattern` a schema may hold. */
const PATTERN_MAX = 1_000;

/**
 * The longest string a schema's pattern is tried on; a longer one does not
 * match it.
 */
export const PATTERN_INPUT_MAX = 4_096;

/**
 * The pattern work one check of a value may do: the characters each
 * pattern is tried on times the size of its compiled program, which bounds
 * a linear-time match. About a tenth of a second; a value that needs more
 * is refused, and says so.
 */
export const PATTERN_WORK_MAX = 20_000_000;

/** What the patterns of the check in progress may still spend. */
const patternWork = { left: PATTERN_WORK_MAX, exceeded: false };

/**
 * Ajv's regular expressions for result schemas (ADR 0336): RE2's, which
 * match in time linear in the input, through re2js, so an agent's value
 * cannot make a project's pattern backtrack on the server's event loop.
 * Each test spends from {@link patternWork}. Ajv keeps one per
 * `toString()`, so each says its own pattern.
 */
const linearRegExp = Object.assign(
  (pattern: string) => {
    const expression = RE2JS.compile(pattern);
    const size = expression.programSize();
    return {
      test: (value: string) => {
        if (value.length > PATTERN_INPUT_MAX) return false;
        patternWork.left -= Math.max(1, value.length) * size;
        if (patternWork.left < 0) {
          patternWork.exceeded = true;
          return false;
        }
        return expression.test(value);
      },
      toString: () => `/${pattern}/`,
    };
  },
  { code: "linearRegExp" },
);

/**
 * Why a pattern is refused when its definition loads, or undefined:
 * patterns run with RE2's semantics, which has no backreferences or
 * lookaround, so a pattern RE2 cannot compile is refused with its reason.
 */
export function unusablePattern(pattern: string): string | undefined {
  if (pattern.length > PATTERN_MAX)
    return `it is over ${PATTERN_MAX.toLocaleString("en-US")} characters`;
  try {
    RE2JS.compile(pattern);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Work matches patterns in linear time (RE2), without backreferences or lookaround: ${reason}`;
  }
}

/** Every regular expression a schema holds: `pattern`s and `patternProperties` keys. */
function schemaPatterns(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node))
    for (const entry of node) schemaPatterns(entry, found);
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" && typeof value === "string") found.push(value);
      if (key === "patternProperties" && value && typeof value === "object")
        found.push(...Object.keys(value));
      schemaPatterns(value, found);
    }
  return found;
}

function schemaProblem(schema: JsonSchemaObject): string | undefined {
  for (const pattern of schemaPatterns(schema)) {
    const unusable = unusablePattern(pattern);
    if (unusable)
      return `pattern ${JSON.stringify(pattern)} is refused: ${unusable}`;
  }
  try {
    compileSchema(schema);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Compiled validators of one core, bounded: definitions reload on every
 * turn, so recompiling each submission's schema would waste the work.
 */
export class ResultValidators {
  /**
   * Replica memory (b): compiled validators keyed by the schema's digest,
   * the least recently used dropped past the limit.
   */
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(private readonly limit = 256) {}

  check(input: {
    schema: JsonSchemaObject;
    value: unknown;
  }): { value: JsonValue } | { errors: ResultFieldError[] } {
    return checkWith(this.validator(input.schema), input.value);
  }

  private validator(schema: JsonSchemaObject): ValidateFunction {
    const key = createHash("sha256")
      .update(JSON.stringify(schema))
      .digest("hex");
    const known = this.compiled.get(key);
    if (known) {
      this.compiled.delete(key);
      this.compiled.set(key, known);
      return known;
    }
    const validate = compileSchema(schema);
    this.compiled.set(key, validate);
    for (const oldest of this.compiled.keys()) {
      if (this.compiled.size <= this.limit) break;
      this.compiled.delete(oldest);
    }
    return validate;
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
 * Check a submitted value against its schema, compiling it afresh (a
 * core checks submissions through its {@link ResultValidators}). A string
 * that does not match but decodes once as JSON to a value that does is
 * accepted decoded: models often send objects and arrays as JSON text.
 */
export function checkResultValue(input: {
  schema: JsonSchemaObject;
  value: unknown;
}): { value: JsonValue } | { errors: ResultFieldError[] } {
  return checkWith(compileSchema(input.schema), input.value);
}

function checkWith(
  validate: ValidateFunction,
  submitted: unknown,
): { value: JsonValue } | { errors: ResultFieldError[] } {
  const text = JSON.stringify(submitted);
  if (text === undefined)
    return { errors: [{ path: "", message: "must be a JSON value" }] };
  const value = JSON.parse(text) as JsonValue;
  if (validated(validate, value)) return { value };
  if (patternWork.exceeded) return { errors: [TOO_MUCH_PATTERN_WORK] };
  const errors = fieldErrors(validate.errors);
  if (typeof value !== "string") return { errors };
  const decoded = decodeOnce(value);
  if (decoded === undefined || typeof decoded === "string") return { errors };
  if (validated(validate, decoded)) return { value: decoded };
  if (patternWork.exceeded) return { errors: [TOO_MUCH_PATTERN_WORK] };
  // It was the right kind of value sent as text: say so, and what to fix in it.
  return {
    errors: [
      {
        path: "",
        message:
          "arrived as JSON text; decoded once, it still does not match. Send it as JSON, and fix",
      },
      ...fieldErrors(validate.errors),
    ],
  };
}

const TOO_MUCH_PATTERN_WORK: ResultFieldError = {
  path: "",
  message:
    "takes too long to check against the schema's patterns; send shorter text",
};

/** One check of a value, with its own budget of pattern work. */
function validated(validate: ValidateFunction, value: JsonValue): boolean {
  patternWork.left = PATTERN_WORK_MAX;
  patternWork.exceeded = false;
  return validate(value) && !patternWork.exceeded;
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
    "Submit a result your definition declares. Only an accepted result counts: whoever reads your work (a workflow, the session that started you) reads results, not your messages. The value must match the result's JSON Schema; a rejected call records nothing and lists each failing field, so correct those fields and call again. Pass value as JSON, not as text. Submit again after a later message asks for something new (a person's, a workflow's, another chat's): a result made before it no longer counts. Your own subsessions' reports and task notifications do not make it stale.",
    "Results:",
    ...names.map((name) => `- ${name}: ${JSON.stringify(schemas[name])}`),
  ].join("\n");
}

export const submitResultInputSchema = z.object({
  name: z.string().min(1).describe("The result's name"),
  // Any JSON: the named schema decides, and its errors say what to fix.
  value: z.unknown().describe("The value, matching that result's JSON Schema"),
});
