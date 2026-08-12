import type { Node, Type } from "ts-morph";

/**
 * TypeScript type → JSON Schema, for workflow inputs and outputs.
 *
 * Workflow IO is constrained to the JSON-compatible subset by the authoring
 * types, so the conversion domain is small. Anything the emitter cannot
 * understand degrades to `{}` (accept anything) rather than failing — a
 * schema that rejects valid input is worse than one that admits too much.
 */

/**
 * Type surface of `@catamorphic/workflow`, injected into the in-memory parse
 * project so `BoundaryContext<Input>` annotations, `pause()` transitions,
 * and `callWorkflow` results resolve to real types instead of `any`. This is
 * the inference-bearing subset of the real package: the author-time
 * validation intersections (`ValidateSteps`, `AssertJsonCompatible`, …) are
 * deliberately omitted — extraction wants inference, not diagnostics.
 * Values the parser treats structurally (`trigger`, `defineSecrets`) are
 * typed loosely.
 */
export const WORKFLOW_STUB_DTS = `
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface RetryBackoff { initial: string; maximum?: string; multiplier?: number }
export interface RetryPolicy { maxAttempts: number; backoff?: RetryBackoff }
export interface BoundaryRateLimit {
  globalKey: string;
  partitionKey?: string;
  capacity: number;
  refillRatePerSecond: number;
  cost?: number;
}

declare const transitionOutput: unique symbol;
export interface WorkflowTransition<Output> { readonly [transitionOutput]: Output }

type PauseState<State> = [State] extends [never] ? object : { state: State };
type ResumedPauseResult<Value, State = never> = {
  reason: "resumed";
  value: Value;
} & PauseState<State>;
export type PauseResult<Value, State = never> =
  | ResumedPauseResult<Value, State>
  | ({ reason: "timed_out" } & PauseState<State>);

export interface Pause {
  <Value extends JsonValue>(): WorkflowTransition<ResumedPauseResult<Value>>;
  <Value extends JsonValue>(options: { timeout: string; signal?: string }): WorkflowTransition<PauseResult<Value>>;
  <Value extends JsonValue, State extends JsonValue>(options: { timeout: string; signal?: string; state: State }): WorkflowTransition<PauseResult<Value, State>>;
  <Value extends JsonValue>(options: { timeout?: never; signal?: string }): WorkflowTransition<ResumedPauseResult<Value>>;
  <Value extends JsonValue, State extends JsonValue>(options: { timeout?: never; signal?: string; state: State }): WorkflowTransition<ResumedPauseResult<Value, State>>;
}

export interface CallWorkflow {
  <Input, Output>(workflow: WorkflowDefinition<Input, Output>, options: { input: Input }): WorkflowTransition<Output>;
}

export interface BoundaryContext<Input> {
  readonly input: Input;
  readonly pause: Pause;
  readonly callWorkflow: CallWorkflow;
}

declare const boundaryTypes: unique symbol;
export interface BoundaryDefinition<Input, Output> { readonly [boundaryTypes]: [Input, Output] }
declare const batchTypes: unique symbol;
export interface BatchDefinition<Input, Output> { readonly [batchTypes]: [Input, Output] }

type ResolveBoundaryReturn<Value> = Value extends WorkflowTransition<infer Output> ? Output : Value;
export type DefineBoundary = <Input, Returned>(options: {
  retry?: RetryPolicy;
  rateLimits?: readonly BoundaryRateLimit[];
  run(context: BoundaryContext<Input>): Returned | Promise<Returned>;
}) => BoundaryDefinition<Input, ResolveBoundaryReturn<Awaited<Returned>>>;

export type DefineBatch = (options: any) => BatchDefinition<any, any>;

export interface WorkflowBuilderContext {
  readonly defineBoundary: DefineBoundary;
  readonly defineBatch: DefineBatch;
}

export interface WorkflowControls { readonly cancel?: true }

type ExecutionUnitInput<Unit> = Unit extends BoundaryDefinition<infer Input, infer _O>
  ? Input
  : Unit extends BatchDefinition<infer Input, infer _O>
    ? Input
    : never;
type ExecutionUnitOutput<Unit> = Unit extends BoundaryDefinition<infer _I, infer Output>
  ? Output
  : Unit extends BatchDefinition<infer _I, infer Output>
    ? Output
    : never;
type Last<Value extends readonly unknown[]> = Value extends readonly [...infer _R, infer Tail] ? Tail : never;

declare const workflowTypes: unique symbol;
export interface WorkflowDefinition<Input, Output, Steps extends readonly unknown[] = readonly unknown[]> {
  readonly [workflowTypes]: [Input, Output];
  readonly steps: Steps;
}

export declare function defineWorkflow<const Steps extends readonly [unknown, ...unknown[]]>(
  build: (context: WorkflowBuilderContext) => {
    readonly steps: Steps;
    readonly controls?: WorkflowControls;
    readonly triggers?: readonly unknown[];
  },
): WorkflowDefinition<ExecutionUnitInput<Steps[0]>, ExecutionUnitOutput<Last<Steps>>, Steps>;

declare const holeName: unique symbol;
export interface Hole<Name extends string = string> { readonly [holeName]: Name }

export interface TriggerKinds {}
export declare function trigger(kind: string, config?: unknown): unknown;
export declare function defineSecrets(declarations: any): any;
export declare function defineBatchStep(options: any): any;
export declare function rateLimited(args: { retryAfterMs: number; message?: string }): never;
export declare class RateLimitedError extends Error {}
export declare const WORKFLOW_PACKAGE_VERSION: string;
`;

const MAX_DEPTH = 8;

type JsonSchema = { [key: string]: unknown };

/** The permissive schema: accepts any JSON value. */
const ANY: JsonSchema = {};

export function jsonSchemaFromType(type: Type, location: Node): unknown {
  return schemaFor(type, location, 0, new Set());
}

function schemaFor(
  type: Type,
  location: Node,
  depth: number,
  seen: Set<string>,
): JsonSchema {
  if (depth > MAX_DEPTH) return ANY;
  if (type.isAny() || type.isUnknown() || type.isNever()) return ANY;
  if (type.isString()) return { type: "string" };
  if (type.isNumber()) return { type: "number" };
  if (type.isBoolean()) return { type: "boolean" };
  if (type.isNull()) return { type: "null" };
  if (type.isStringLiteral()) {
    return { const: type.getLiteralValue() as string };
  }
  if (type.isNumberLiteral()) {
    return { const: type.getLiteralValue() as number };
  }
  if (type.isBooleanLiteral()) {
    return { const: type.getText() === "true" };
  }
  if (type.isEnum() || type.isEnumLiteral()) {
    return ANY;
  }
  if (type.isUnion()) {
    return unionSchema(type, location, depth, seen);
  }
  if (type.isIntersection()) {
    // JSON-compatible intersections are object merges; emit the merged
    // property set by treating the intersection as one object type.
    return objectSchema(type, location, depth, seen);
  }
  const arrayElement = type.getArrayElementType();
  if (arrayElement) {
    return {
      type: "array",
      items: schemaFor(arrayElement, location, depth + 1, seen),
    };
  }
  if (type.isTuple()) {
    return {
      type: "array",
      items:
        type.getTupleElements().length > 0
          ? {
              anyOf: type
                .getTupleElements()
                .map((element) =>
                  schemaFor(element, location, depth + 1, seen),
                ),
            }
          : ANY,
    };
  }
  if (type.isObject()) {
    const key = typeIdentity(type);
    if (key && seen.has(key)) return ANY;
    if (key) seen.add(key);
    try {
      return objectSchema(type, location, depth, seen);
    } finally {
      if (key) seen.delete(key);
    }
  }
  return ANY;
}

function unionSchema(
  type: Type,
  location: Node,
  depth: number,
  seen: Set<string>,
): JsonSchema {
  const members = type
    .getUnionTypes()
    .filter((member) => !member.isUndefined());
  if (members.length === 0) return ANY;
  // TS splits `boolean` into true | false inside unions; merge back.
  const literals = members.filter(
    (member) => member.isStringLiteral() || member.isNumberLiteral(),
  );
  const booleans = members.filter(
    (member) => member.isBooleanLiteral() || member.isBoolean(),
  );
  const others = members.filter(
    (member) =>
      !member.isStringLiteral() &&
      !member.isNumberLiteral() &&
      !member.isBooleanLiteral() &&
      !member.isBoolean(),
  );
  const parts: JsonSchema[] = [];
  if (literals.length > 0 && others.length === 0 && booleans.length === 0) {
    return { enum: literals.map((member) => member.getLiteralValue()) };
  }
  if (literals.length > 0) {
    parts.push({ enum: literals.map((member) => member.getLiteralValue()) });
  }
  if (booleans.length > 0) parts.push({ type: "boolean" });
  for (const member of others) {
    parts.push(schemaFor(member, location, depth + 1, seen));
  }
  if (parts.length === 1 && parts[0]) return parts[0];
  // Collapse duplicate wide members (e.g. any-degraded arms).
  if (parts.some((part) => Object.keys(part).length === 0)) return ANY;
  return { anyOf: parts };
}

function objectSchema(
  type: Type,
  location: Node,
  depth: number,
  seen: Set<string>,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const property of type.getProperties()) {
    const name = property.getName();
    // Symbol-keyed and private brand members are not data.
    if (name.startsWith("__@") || name.startsWith("__#")) continue;
    const propertyType = property.getTypeAtLocation(location);
    const optional =
      property.isOptional() ||
      (propertyType.isUnion() &&
        propertyType.getUnionTypes().some((member) => member.isUndefined()));
    properties[name] = schemaFor(propertyType, location, depth + 1, seen);
    if (!optional) required.push(name);
  }
  const stringIndex = type.getStringIndexType();
  const schema: JsonSchema = { type: "object" };
  if (Object.keys(properties).length > 0) {
    schema.properties = properties;
    if (required.length > 0) schema.required = required;
  }
  if (stringIndex) {
    schema.additionalProperties = schemaFor(
      stringIndex,
      location,
      depth + 1,
      seen,
    );
  }
  if (Object.keys(properties).length === 0 && !stringIndex) return ANY;
  return schema;
}

function typeIdentity(type: Type): string | null {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (!symbol) return null;
  const declaration = symbol.getDeclarations()[0];
  if (!declaration) return null;
  return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
}

/**
 * JSON Schema of a boundary run callback's resolved output: `Promise<T>`
 * and `WorkflowTransition<T>` wrappers are unwrapped (per arm, for a union
 * of transitions and values) — the same resolution `ResolveBoundaryReturn`
 * performs at the type level.
 */
export function jsonSchemaFromBoundaryReturn(
  returnType: Type,
  location: Node,
): unknown {
  const awaited = unwrapNamed(returnType, "Promise");
  if (awaited.isUnion()) {
    const arms = awaited
      .getUnionTypes()
      .map((member) => unwrapNamed(member, "WorkflowTransition"));
    const schemas = arms.map((arm) => schemaFor(arm, location, 0, new Set()));
    if (schemas.some((schema) => Object.keys(schema).length === 0)) return ANY;
    return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
  }
  const resolved = unwrapNamed(awaited, "WorkflowTransition");
  return schemaFor(resolved, location, 0, new Set());
}

function unwrapNamed(type: Type, name: string): Type {
  let current = type;
  for (let i = 0; i < 4; i += 1) {
    const symbolName =
      current.getSymbol()?.getName() ?? current.getAliasSymbol()?.getName();
    if (symbolName !== name) return current;
    const argument = current.getTypeArguments()[0];
    if (!argument) return current;
    current = argument;
  }
  return current;
}
