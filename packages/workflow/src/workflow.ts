import {
  type BatchDefinition,
  createBatch,
  type DefineBatch,
} from "./batch.js";
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

  constructor(args: { steps: Steps; controls?: WorkflowControls }) {
    this.steps = args.steps;
    this.controls = args.controls;
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

type PlainWorkflowInput<Target extends (input: never) => unknown> =
  Parameters<Target> extends [infer Input] ? Input : never;

type PlainWorkflowOutput<Target extends (input: never) => unknown> = Awaited<
  ReturnType<Target>
>;

type ValidatePlainWorkflowTarget<Target extends (input: never) => unknown> =
  Parameters<Target> extends [infer Input]
    ? Input extends readonly unknown[]
      ? WorkflowTypeError<
          "A plain workflow must accept one keyed input object",
          Input
        >
      : Input extends object
        ? ReturnType<Target> extends Promise<infer Output>
          ? AssertJsonCompatible<
              Input,
              "A plain workflow input must be JSON-compatible"
            > &
              AssertJsonCompatible<
                Output,
                "A plain workflow output must be JSON-compatible"
              >
          : WorkflowTypeError<
              "A plain workflow target must be async",
              ReturnType<Target>
            >
        : WorkflowTypeError<
            "A plain workflow must accept one keyed input object",
            Input
          >
    : WorkflowTypeError<
        "A plain workflow must accept exactly one keyed input object",
        Parameters<Target>
      >;

export interface CallWorkflow {
  <Input, Output>(
    workflow: WorkflowDefinition<Input, Output>,
    options: { input: Input },
  ): WorkflowTransition<Output>;
  <Target extends (input: never) => unknown>(
    workflow: Target & ValidatePlainWorkflowTarget<Target>,
    options: { input: PlainWorkflowInput<Target> },
  ): WorkflowTransition<PlainWorkflowOutput<Target>>;
}

export interface BoundaryContext<Input> {
  readonly input: Input;
  readonly pause: Pause;
  readonly callWorkflow: CallWorkflow;
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
>(
  build: (context: WorkflowBuilderContext) => {
    readonly steps: Steps;
    readonly controls?: WorkflowControls;
  } & ValidateSteps<Steps>,
): WorkflowDefinition<
  ExecutionUnitInput<Steps[0]>,
  ExecutionUnitOutput<Last<Steps>>,
  Steps
> {
  const definition = build(workflowBuilderContext);
  return new WorkflowDefinitionImpl({
    steps: definition.steps,
    controls: definition.controls,
  });
}
