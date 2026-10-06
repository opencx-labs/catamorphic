import type { Where } from "./where.js";

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
export {
  PROJECT_PERMISSIONS,
  type ProjectPermissionName,
  type WorkflowPermission,
} from "./permissions.js";
export type {
  SecretDeclaration,
  SecretDeclarations,
  Secrets,
} from "./secrets.js";
export {
  defineSecrets,
  MissingSecretError,
  WebhookOnlySecretError,
} from "./secrets.js";
export type {
  Narrow,
  Where,
  WhereAny,
  WhereExists,
  WherePrefix,
  WherePrimitive,
} from "./where.js";
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
 * per-project by the generated `work-triggers.d.ts`. Until that file
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

/** A kind without config (`Record<string, never>`) contributes no keys. */
type OwnConfig<Config> = string extends keyof Config
  ? [Config[string & keyof Config]] extends [never]
    ? unknown
    : Config
  : Config;

/**
 * What a binding writes: the kind's own config plus `where`, the filter
 * every binding may add (ADR 0171). The host removes `where` before it
 * validates the kind's config and evaluates it before a run starts.
 */
export type TriggerBindingConfig<Kind extends TriggerKindName> = OwnConfig<
  TriggerConfig<Kind>
> & {
  readonly where?: Where<TriggerPayload<Kind>>;
};

type ConfigArg<Kind extends TriggerKindName> =
  Record<string, never> extends TriggerConfig<Kind>
    ? [config?: TriggerBindingConfig<Kind>]
    : [config: TriggerBindingConfig<Kind>];

/**
 * Binds the enclosing workflow to a trigger kind: one the host registers or
 * one the project defines with `defineTrigger`. Only valid inside
 * `defineWorkflow`'s `triggers` list or a `defineTrigger`'s `from`; the
 * config argument must be a constant expression.
 */
export function trigger<Kind extends TriggerKindName>(
  kind: Kind,
  ...args: ConfigArg<Kind>
): TriggerBinding<TriggerPayload<Kind>, TriggerOutput<Kind>> {
  return new TriggerBindingImpl({ kind, config: args[0] ?? {} });
}

/** The payload a binding delivers. */
export type BindingPayload<Binding> =
  Binding extends TriggerBinding<infer Payload, unknown> ? Payload : never;

class ProjectTriggerImpl<Payload> {
  private declare readonly payload: Payload;

  readonly name: string;
  readonly description: string | undefined;
  readonly from: TriggerBinding<unknown, unknown>;
  readonly where: unknown;

  constructor(args: {
    name: string;
    description?: string;
    from: TriggerBinding<unknown, unknown>;
    where?: unknown;
  }) {
    this.name = args.name;
    this.description = args.description;
    this.from = args.from;
    this.where = args.where;
  }
}

/**
 * A trigger kind the project defines on top of another kind (ADR 0171).
 * The host reads it statically from `.work/triggers/`; nothing about it
 * runs. Workflows bind it by name like any host kind.
 */
export type ProjectTrigger<Payload> = ProjectTriggerImpl<Payload>;

/** The payload a project trigger kind delivers to its workflows. */
export type PayloadOf<Kind> =
  Kind extends ProjectTrigger<infer Payload> ? Payload : never;

interface ProjectTriggerDefinition<From, Filtered> {
  /** The name workflows bind, e.g. "github.pull_request". A string literal. */
  readonly name: string;
  /** Shown to workflow authors in the generated types. */
  readonly description?: string;
  /** The kind this one narrows: a direct `trigger(...)` call. */
  readonly from: From;
  /** What the underlying event must hold for this kind to fire. */
  readonly where?: Where<Filtered>;
}

/**
 * Defines a project trigger kind: another kind's binding narrowed by a
 * declarative `where`. Pass a type argument to type the payload more
 * precisely than the underlying kind does (a webhook's parsed body, say);
 * it is the author's claim about what the filtered events carry. Write it in
 * `.work/triggers/<name>.ts` as an exported constant.
 */
export function defineTrigger<
  const From extends TriggerBinding<unknown, unknown>,
>(
  definition: ProjectTriggerDefinition<From, BindingPayload<From>>,
): ProjectTrigger<BindingPayload<From>>;
export function defineTrigger<Payload = never>(
  definition: ProjectTriggerDefinition<
    TriggerBinding<unknown, unknown>,
    NoInfer<Payload>
  >,
): ProjectTrigger<Payload>;
export function defineTrigger(
  definition: ProjectTriggerDefinition<
    TriggerBinding<unknown, unknown>,
    unknown
  >,
): ProjectTrigger<unknown> {
  return new ProjectTriggerImpl(definition);
}

export const WORKFLOW_PACKAGE_VERSION = "0.0.4";

export type {
  SecretHostOperations,
  SecretStatusEntry,
} from "./secret-operations.js";
export type {
  SessionHistoryMessage,
  SessionHostOperations,
  SessionSnapshot,
} from "./session-operations.js";
