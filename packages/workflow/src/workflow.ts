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

export type PauseOptions<State extends JsonValue = JsonValue> =
  | { timeout?: never; state?: State }
  | { timeout: string; state?: State };

type PauseState<State> = [State] extends [never] ? object : { state: State };

type ResumedPauseResult<Value, State = never> = {
  reason: "resumed";
  value: Value;
} & PauseState<State>;

export type PauseResult<Value, State = never> =
  | ResumedPauseResult<Value, State>
  | ({ reason: "timed_out" } & PauseState<State>);

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

  constructor(args: {
    run: (context: BoundaryContext<Input>) => unknown | Promise<unknown>;
    retry?: RetryPolicy;
  }) {
    this.run = args.run;
    this.retry = args.retry;
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
  }): WorkflowTransition<PauseResult<Value>>;
  <Value extends JsonValue, State extends JsonValue>(options: {
    timeout: string;
    state: State;
  }): WorkflowTransition<PauseResult<Value, State>>;
  <Value extends JsonValue>(options: {
    timeout?: never;
  }): WorkflowTransition<ResumedPauseResult<Value>>;
  <Value extends JsonValue, State extends JsonValue>(options: {
    timeout?: never;
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
  return new BoundaryDefinitionImpl({ run: options.run, retry: options.retry });
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
