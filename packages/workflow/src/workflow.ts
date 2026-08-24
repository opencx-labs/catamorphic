import {
  type BatchDefinition,
  createBatch,
  type DefineBatch,
} from "./batch.js";
import type { OutputTemplateMatches, PayloadTemplateMatches } from "./holes.js";
import type { TriggerBinding } from "./index.js";
import type {
  AssertJsonCompatible,
  JsonValue,
  WorkflowTypeError,
} from "./json.js";

export interface RetryBackoff {
  initial: string;
  maximum?: string;
  multiplier?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoff?: RetryBackoff;
}

/**
 * A share of a token bucket that gates a boundary before it is dispatched.
 *
 * Buckets are keyed per tenant, not per run or per workflow, so every boundary
 * naming the same `globalKey` draws on one budget — which is what makes a
 * single shared third-party account (one WhatsApp sender, one ESP) safe to
 * drive from many workflows at once. Waiting for capacity is not a failure: a
 * boundary that cannot reserve is rescheduled without consuming a retry and
 * without holding a sandbox.
 */
export interface BoundaryRateLimit {
  /** Bucket identity shared across every workflow in the tenant. */
  globalKey: string;
  /** Subdivides the bucket, e.g. one sender number within an account. */
  partitionKey?: string;
  /** Burst ceiling in tokens. */
  capacity: number;
  /** Sustained refill in tokens per second. */
  refillRatePerSecond: number;
  /** Tokens this boundary consumes per attempt. Defaults to 1. */
  cost?: number;
}

export type PauseOptions<State extends JsonValue = JsonValue> =
  | { timeout?: never; signal?: string; state?: State }
  | { timeout: string; signal?: string; state?: State };

type PauseState<State> = [State] extends [never] ? object : { state: State };

type ResumedPauseResult<Value, State = never> = {
  reason: "resumed";
  value: Value;
} & PauseState<State>;

export type PauseResult<Value, State = never> =
  | ResumedPauseResult<Value, State>
  | ({ reason: "timed_out" } & PauseState<State>);

/**
 * Reports that a third party refused the call for rate reasons, usually a 429
 * carrying `Retry-After`.
 *
 * Throwing this does not fail the boundary. The provider's own answer is fed
 * back into the buckets the boundary declared, blocking every other workflow
 * drawing on the same shared account, and the boundary is rescheduled without
 * consuming a retry attempt. Prefer it over a bare throw whenever the remote
 * side tells you how long to wait.
 */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(args: { retryAfterMs: number; message?: string }) {
    if (!Number.isFinite(args.retryAfterMs) || args.retryAfterMs <= 0) {
      throw new Error("retryAfterMs must be a positive finite number");
    }
    super(args.message ?? `Rate limited for ${args.retryAfterMs}ms`);
    this.name = "RateLimitedError";
    this.retryAfterMs = args.retryAfterMs;
  }
}

/** Reports rate-limit backpressure from a third party. See {@link RateLimitedError}. */
export function rateLimited(args: {
  retryAfterMs: number;
  message?: string;
}): never {
  throw new RateLimitedError(args);
}

class WorkflowTransitionImpl<Output> {
  private declare readonly output: Output;
}

/** An instruction that resolves before the next workflow step starts. */
export type WorkflowTransition<Output> = WorkflowTransitionImpl<Output>;

class BoundaryDefinitionImpl<Input, Output> {
  private declare readonly input: Input;
  private declare readonly output: Output;

  readonly run: (context: BoundaryContext<Input>) => unknown | Promise<unknown>;
  readonly retry?: RetryPolicy;
  readonly rateLimits?: readonly BoundaryRateLimit[];

  constructor(args: {
    run: (context: BoundaryContext<Input>) => unknown | Promise<unknown>;
    retry?: RetryPolicy;
    rateLimits?: readonly BoundaryRateLimit[];
  }) {
    this.run = args.run;
    this.retry = args.retry;
    this.rateLimits = args.rateLimits;
    Object.defineProperty(this, "kind", { value: "durable-boundary" });
  }
}

/** An atomic durable retry scope whose callback operations retry together. */
export type BoundaryDefinition<Input, Output> = BoundaryDefinitionImpl<
  Input,
  Output
>;

class WorkflowDefinitionImpl<Input, Output, Steps extends readonly unknown[]> {
  private declare readonly input: Input;
  private declare readonly output: Output;

  readonly steps: Steps;
  readonly controls?: WorkflowControls;
  readonly triggers?: readonly TriggerBinding<unknown>[];
  readonly connections?: readonly (string | WorkflowConnectionRequirement)[];

  constructor(args: {
    steps: Steps;
    controls?: WorkflowControls;
    triggers?: readonly TriggerBinding<unknown>[];
    connections?: readonly (string | WorkflowConnectionRequirement)[];
  }) {
    this.steps = args.steps;
    this.controls = args.controls;
    this.triggers = args.triggers;
    this.connections = args.connections;
    Object.defineProperty(this, "kind", { value: "durable-workflow" });
  }
}

/** A statically defined durable workflow. */
export type WorkflowDefinition<
  Input,
  Output,
  Steps extends readonly unknown[] = readonly unknown[],
> = WorkflowDefinitionImpl<Input, Output, Steps>;

export interface Pause {
  <Value extends JsonValue>(): WorkflowTransition<ResumedPauseResult<Value>>;
  <Value extends JsonValue>(options: {
    timeout: string;
    signal?: string;
  }): WorkflowTransition<PauseResult<Value>>;
  <Value extends JsonValue, State extends JsonValue>(options: {
    timeout: string;
    signal?: string;
    state: State;
  }): WorkflowTransition<PauseResult<Value, State>>;
  <Value extends JsonValue>(options: {
    timeout?: never;
    signal?: string;
  }): WorkflowTransition<ResumedPauseResult<Value>>;
  <Value extends JsonValue, State extends JsonValue>(options: {
    timeout?: never;
    signal?: string;
    state: State;
  }): WorkflowTransition<ResumedPauseResult<Value, State>>;
}

export type CallWorkflow = <Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
  options: { input: Input },
) => WorkflowTransition<Output>;

/**
 * Who triggered the run (ADR 0055): stamped by the host at trigger time from
 * the verified identity — never from `input`, which is author-typed. Absent
 * for runs the host started as itself (root). `scope` is the caller's
 * artifact refs (a viewer's grants); a full builder shows `scope: undefined`.
 */
export interface WorkflowCaller {
  readonly externalUserId: string;
  readonly scope?: ReadonlyArray<{
    readonly kind: string;
    readonly projectId: string;
    readonly [key: string]: unknown;
  }>;
}

/**
 * A host-executed call, returned from a boundary like `callWorkflow`
 * (ADR 0055): the boundary ends, the host runs the function with the run's
 * caller attached, and the result becomes the next step's input. Retries
 * of the step re-run the call — at-least-once, like any step IO.
 */
export type HostCall<Result = unknown> = <Args>(
  args: Args,
) => WorkflowTransition<Result>;

/** `context.host.<capability…>.<fn>(args)`: dotted capability namespaces. */
export interface HostNamespace {
  readonly [name: string]: HostNamespace & HostCall;
}

export interface WorkflowConnectionRequirement {
  readonly alias: string;
  readonly principal?: "member" | "service" | "either";
  readonly capabilities?: readonly string[];
  readonly optional?: boolean;
}

/** `context.connections.<alias>.<action>(args)` durable broker calls. */
export interface ConnectionNamespace {
  readonly [name: string]: ConnectionNamespace & HostCall;
}

export interface DocumentEntry {
  path: string;
  source: "program" | "store";
  contentType: string;
  size: number;
  version?: number;
  writtenBy?: string;
  writtenAt?: string;
}

/**
 * The documents surface, caller-bound (ADR 0055): every operation runs on
 * the host with the run's caller identity, so a workflow can only ever
 * reach what the caller may — search included. Same transition semantics
 * as `callWorkflow`: return the call, receive the result in the next step.
 */
export interface DocumentsCalls {
  list(args: {
    prefix?: string;
    source?: "program" | "store";
  }): WorkflowTransition<DocumentEntry[]>;
  read(args: {
    path: string;
    version?: number;
  }): WorkflowTransition<DocumentEntry & { text?: string }>;
  write(args: {
    path: string;
    text: string;
    contentType?: string;
    ifVersion?: number;
  }): WorkflowTransition<DocumentEntry>;
  delete(args: {
    path: string;
    ifVersion?: number;
  }): WorkflowTransition<{ version: number }>;
  history(args: { path: string }): WorkflowTransition<
    Array<{
      version: number;
      deleted: boolean;
      contentType: string;
      size: number;
      writtenBy: string;
      writtenAt: string;
    }>
  >;
  search(args: {
    query: string;
    mode?: "grep" | "text";
    prefix?: string;
    limit?: number;
  }): WorkflowTransition<
    Array<{
      path: string;
      source: "program" | "store";
      lines: Array<{ line: number; text: string }>;
    }>
  >;
}

export interface BoundaryContext<Input> {
  readonly input: Input;
  readonly pause: Pause;
  readonly callWorkflow: CallWorkflow;
  /** Who triggered the run; absent when the host started it as itself. */
  readonly caller?: WorkflowCaller;
  /** Host-executed capability calls, caller-bound (ADR 0055). */
  readonly host: HostNamespace;
  /** The documents surface, caller-bound (ADR 0055). */
  readonly documents: DocumentsCalls;
  /** Brokered external-system calls. Credential material stays host-side. */
  readonly connections: ConnectionNamespace;
}

export interface BoundaryOptions<Input, Returned> {
  retry?: RetryPolicy;
  rateLimits?: readonly BoundaryRateLimit[];
  run(context: BoundaryContext<Input>): Returned | Promise<Returned>;
}

type WorkflowDefinitionPart<Value> =
  Value extends WorkflowDefinition<infer _Input, infer _Output> ? Value : never;

type ResolveBoundaryReturn<Value> =
  Value extends WorkflowTransition<infer Output> ? Output : Value;

type ValidateBoundary<Input, Returned> = AssertJsonCompatible<
  Input,
  "A boundary input must be JSON-compatible"
> &
  ([WorkflowDefinitionPart<Returned>] extends [never]
    ? AssertJsonCompatible<
        ResolveBoundaryReturn<Returned>,
        "A boundary must resolve to a JSON-compatible value"
      >
    : WorkflowTypeError<
        "Return callWorkflow(workflow, { input }) instead of returning a workflow definition",
        WorkflowDefinitionPart<Returned>
      >);

export type DefineBoundary = <Input, Returned>(
  options: BoundaryOptions<Input, Returned> &
    ValidateBoundary<Input, Awaited<Returned>>,
) => BoundaryDefinition<Input, ResolveBoundaryReturn<Awaited<Returned>>>;

export interface WorkflowBuilderContext {
  readonly defineBoundary: DefineBoundary;
  readonly defineBatch: DefineBatch;
}

export interface WorkflowControls {
  /**
   * Declares that hosts may expose their authenticated run cancellation
   * control. The host still owns authorization and actual availability.
   */
  readonly cancel?: true;
}

type ExecutionUnitInput<Unit> =
  Unit extends BoundaryDefinition<infer Input, infer _Output>
    ? Input
    : Unit extends BatchDefinition<infer Input, infer _Output>
      ? Input
      : never;

type ExecutionUnitOutput<Unit> =
  Unit extends BoundaryDefinition<infer _Input, infer Output>
    ? Output
    : Unit extends BatchDefinition<infer _Input, infer Output>
      ? Output
      : never;

type ValidateSteps<
  Steps extends readonly unknown[],
  Position extends readonly unknown[] = [],
> = Steps extends readonly [infer Current, ...infer Rest]
  ? Current extends
      | BoundaryDefinition<infer _Input, infer Output>
      | BatchDefinition<infer _Input, infer Output>
    ? Rest extends readonly [infer Next, ...infer _Tail]
      ? Next extends
          | BoundaryDefinition<infer NextInput, infer _NextOutput>
          | BatchDefinition<infer NextInput, infer _NextOutput>
        ? [Output] extends [NextInput]
          ? ValidateSteps<Rest, readonly [...Position, unknown]>
          : WorkflowTypeError<
              `Workflow step ${[
                ...Position,
                unknown,
              ]["length"]} resolves to a value that workflow step ${[
                ...Position,
                unknown,
                unknown,
              ]["length"]} does not accept`,
              { resolvedOutput: Output; nextInput: NextInput }
            >
        : WorkflowTypeError<
            `Workflow step ${[
              ...Position,
              unknown,
              unknown,
            ]["length"]} must be created by defineBoundary or defineBatch`,
            Next
          >
      : unknown
    : WorkflowTypeError<
        `Workflow step ${[
          ...Position,
          unknown,
        ]["length"]} must be created by defineBoundary or defineBatch`,
        Current
      >
  : WorkflowTypeError<
      "A workflow must contain at least one boundary or batch",
      Steps
    >;

type Last<Value extends readonly unknown[]> = Value extends readonly [
  ...infer _Rest,
  infer Tail,
]
  ? Tail
  : never;

type ValidateTriggers<
  Triggers extends readonly unknown[],
  Input,
  Output,
  Position extends readonly unknown[] = [],
> = Triggers extends readonly [infer Current, ...infer Rest]
  ? Current extends TriggerBinding<infer Payload, infer OutputTemplate>
    ? PayloadTemplateMatches<Payload, Input> extends true
      ? OutputTemplateMatches<OutputTemplate, Output> extends true
        ? ValidateTriggers<Rest, Input, Output, readonly [...Position, unknown]>
        : WorkflowTypeError<
            `Trigger ${[
              ...Position,
              unknown,
            ]["length"]} demands an output the workflow's final step does not produce`,
            { triggerOutput: OutputTemplate; stepOutput: Output }
          >
      : WorkflowTypeError<
          `Trigger ${[
            ...Position,
            unknown,
          ]["length"]} delivers a payload the first workflow step does not accept`,
          { triggerPayload: Payload; stepInput: Input }
        >
    : WorkflowTypeError<
        `Trigger ${[...Position, unknown]["length"]} must be created by trigger()`,
        Current
      >
  : unknown;

function createBoundary<Input, Returned>(
  options: BoundaryOptions<Input, Returned> &
    ValidateBoundary<Input, Awaited<Returned>>,
): BoundaryDefinition<Input, ResolveBoundaryReturn<Awaited<Returned>>> {
  assertRateLimits(options.rateLimits);
  return new BoundaryDefinitionImpl({
    run: options.run,
    retry: options.retry,
    rateLimits: options.rateLimits,
  });
}

function assertRateLimits(
  limits: readonly BoundaryRateLimit[] | undefined,
): void {
  if (!limits) return;
  const seen = new Set<string>();
  for (const limit of limits) {
    assertKeyPart({ name: "globalKey", value: limit.globalKey });
    if (limit.partitionKey !== undefined) {
      assertKeyPart({ name: "partitionKey", value: limit.partitionKey });
    }
    const identity = `${limit.globalKey.length}:${limit.globalKey}${limit.partitionKey ?? ""}`;
    if (seen.has(identity)) {
      throw new Error(
        "Boundary rate limit keys must be unique within a boundary",
      );
    }
    seen.add(identity);
    assertPositiveRateValue({ name: "capacity", value: limit.capacity });
    assertPositiveRateValue({
      name: "refillRatePerSecond",
      value: limit.refillRatePerSecond,
    });
    assertPositiveRateValue({ name: "cost", value: limit.cost ?? 1 });
    if ((limit.cost ?? 1) > limit.capacity) {
      throw new Error("Boundary rate limit cost cannot exceed capacity");
    }
  }
}

function assertKeyPart(args: { name: string; value: string }): void {
  if (args.value.length === 0 || args.value.length > 500) {
    throw new Error(
      `Boundary rate limit ${args.name} must contain 1 to 500 characters`,
    );
  }
}

function assertPositiveRateValue(args: { name: string; value: number }): void {
  if (!Number.isFinite(args.value) || args.value <= 0) {
    throw new Error(`Boundary rate limit ${args.name} must be positive`);
  }
}

const workflowBuilderContext: WorkflowBuilderContext = {
  defineBoundary: createBoundary,
  defineBatch: createBatch,
};

export function defineWorkflow<
  const Steps extends readonly [unknown, ...unknown[]],
  const Triggers extends readonly TriggerBinding<unknown>[] = readonly [],
>(
  build: (context: WorkflowBuilderContext) => {
    readonly steps: Steps;
    readonly controls?: WorkflowControls;
    readonly triggers?: Triggers;
    readonly connections?: readonly (string | WorkflowConnectionRequirement)[];
  } & ValidateSteps<Steps> &
    ValidateTriggers<
      Triggers,
      ExecutionUnitInput<Steps[0]>,
      ExecutionUnitOutput<Last<Steps>>
    >,
): WorkflowDefinition<
  ExecutionUnitInput<Steps[0]>,
  ExecutionUnitOutput<Last<Steps>>,
  Steps
> {
  const definition = build(workflowBuilderContext);
  return new WorkflowDefinitionImpl({
    steps: definition.steps,
    controls: definition.controls,
    triggers: definition.triggers,
    connections: definition.connections,
  });
}
