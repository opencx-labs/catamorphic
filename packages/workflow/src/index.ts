export type {
  BatchConsistency,
  BatchDefinition,
  BatchExecutionContext,
  BatchFailure,
  BatchFailurePolicy,
  BatchOptions,
  BatchOutput,
  BatchSink,
  BatchSinkRecord,
  BatchSinkWriteResult,
  BatchSource,
  BatchSourceBinding,
  BatchStepDefinition,
  BatchStepPolicy,
  BatchStepRateLimit,
  BatchSummary,
  DefineBatch,
  JsonPrimitive,
  JsonValue,
  KeyedBatchFailure,
  KeyedBatchOutcome,
  KeyedBatchSkipped,
  KeyedBatchSuccess,
  SourceInitialization,
  SourceItem,
  SourcePage,
} from "./batch.js";
export {
  BatchItemSkippedError,
  batchFailed,
  batchSkipped,
  batchSucceeded,
  defineBatchStep,
  skipBatchItem,
  validateKeyedBatchOutcomes,
} from "./batch.js";
export type { Hole } from "./holes.js";
export type {
  SecretDeclaration,
  SecretDeclarations,
  Secrets,
} from "./secrets.js";
export { defineSecrets, MissingSecretError } from "./secrets.js";
export type {
  BoundaryContext,
  BoundaryDefinition,
  BoundaryOptions,
  BoundaryRateLimit,
  CallWorkflow,
  ConnectionNamespace,
  DefineBoundary,
  DocumentEntry,
  DocumentsCalls,
  HostCall,
  HostNamespace,
  Pause,
  PauseOptions,
  PauseResult,
  RetryBackoff,
  RetryPolicy,
  WorkflowBuilderContext,
  WorkflowCaller,
  WorkflowConnectionRequirement,
  WorkflowControls,
  WorkflowDefinition,
  WorkflowTransition,
} from "./workflow.js";
export {
  defineWorkflow,
  RateLimitedError,
  rateLimited,
} from "./workflow.js";

// The trigger surface lives directly in this module (not a re-export):
// project workspaces receive a generated `declare module
// "@catamorphic/workflow"` augmentation of TriggerKinds, and module
// augmentation only merges with interfaces declared in the resolved module
// itself.

/**
 * The catalog of trigger kinds the embedding host registers. Augmented
 * per-project by the generated `catamorphic-triggers.d.ts`. Until that file
 * exists, `trigger()` is uncallable — a workflow cannot bind to a kind the
 * host never registered.
 */
// biome-ignore lint/suspicious/noEmptyInterface: a type alias cannot be merged by the generated module augmentation
export interface TriggerKinds {}

export type TriggerKindName = keyof TriggerKinds & string;

/**
 * The payload the host fires with — delivered verbatim as the workflow
 * input. May contain `Hole<Name>` positions: a parameterized kind leaves
 * those open, and each bound workflow's own input type fills them in.
 */
export type TriggerPayload<Kind extends TriggerKindName> =
  TriggerKinds[Kind] extends { payload: infer Payload } ? Payload : never;

/**
 * The output template the kind demands of subscribed workflows (e.g. an
 * HTTP response envelope), or `unknown` when the kind declares none. Like
 * payloads, templates may contain `Hole` positions the workflow fills.
 */
export type TriggerOutput<Kind extends TriggerKindName> =
  TriggerKinds[Kind] extends { output: infer Output } ? Output : unknown;

/**
 * The per-workflow configuration the kind demands, e.g. a tool description
 * for an AI tool-call kind. Must be written as a constant expression: the
 * parser extracts it statically so hosts can introspect bindings without
 * running project code.
 */
export type TriggerConfig<Kind extends TriggerKindName> =
  TriggerKinds[Kind] extends { config: infer Config } ? Config : never;

class TriggerBindingImpl<Payload, Output = unknown> {
  private declare readonly payload: Payload;
  private declare readonly output: Output;

  readonly kind: string;
  readonly config: unknown;

  constructor(args: { kind: string; config: unknown }) {
    this.kind = args.kind;
    this.config = args.config;
    Object.defineProperty(this, "binding", { value: "trigger" });
  }
}

/** A workflow's declared subscription to a host trigger kind. */
export type TriggerBinding<Payload, Output = unknown> = TriggerBindingImpl<
  Payload,
  Output
>;

type ConfigArg<Kind extends TriggerKindName> =
  Record<string, never> extends TriggerConfig<Kind>
    ? [config?: TriggerConfig<Kind>]
    : [config: TriggerConfig<Kind>];

/**
 * Binds the enclosing workflow to a host-defined trigger kind. Only valid
 * inside `defineWorkflow`'s `triggers` list; the config argument must be a
 * constant expression.
 */
export function trigger<Kind extends TriggerKindName>(
  kind: Kind,
  ...args: ConfigArg<Kind>
): TriggerBinding<TriggerPayload<Kind>, TriggerOutput<Kind>> {
  return new TriggerBindingImpl({ kind, config: args[0] ?? {} });
}

export const WORKFLOW_PACKAGE_VERSION = "0.0.2";
