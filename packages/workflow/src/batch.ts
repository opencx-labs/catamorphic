import type { AssertJsonCompatible, JsonValue } from "./json.js";

export type { JsonPrimitive, JsonValue } from "./json.js";

export type BatchConsistency = "snapshot" | "bounded" | "best_effort";

export interface BatchExecutionContext {
  invocationId: string;
  attempt: number;
  deadlineAt: string;
  signal: AbortSignal;
}

export interface SourceItem<Item> {
  key: string;
  value: Item;
  attempt?: number;
}

export interface SourcePage<Item, Cursor> {
  items: readonly SourceItem<Item>[];
  nextCursor?: Cursor;
  done: boolean;
}

export interface SourceInitialization<Cursor, Snapshot> {
  snapshot: Snapshot;
  cursor?: Cursor;
  estimatedCount?: number;
}

export interface BatchSource<
  Config,
  Item,
  Cursor = JsonValue,
  Snapshot = JsonValue,
> {
  readonly consistency: BatchConsistency;
  initialize(args: {
    config: Config;
    context: BatchExecutionContext;
  }): Promise<SourceInitialization<Cursor, Snapshot>>;
  readPage(args: {
    config: Config;
    snapshot: Snapshot;
    cursor?: Cursor;
    limit: number;
    context: BatchExecutionContext;
  }): Promise<SourcePage<Item, Cursor>>;
}

export interface BatchSourceBinding<
  Config,
  Item,
  Cursor = JsonValue,
  Snapshot = JsonValue,
> {
  source: BatchSource<Config, Item, Cursor, Snapshot>;
  config: Config;
}

export interface BatchFailure {
  message: string;
  code?: string;
  retryable?: boolean;
  details?: JsonValue;
}

export interface KeyedBatchSuccess<Result> {
  key: string;
  status: "succeeded";
  result: Result;
}

export interface KeyedBatchFailure {
  key: string;
  status: "failed";
  error: BatchFailure;
}

export interface KeyedBatchSkipped {
  key: string;
  status: "skipped";
  reason?: string;
}

export type KeyedBatchOutcome<Result> =
  | KeyedBatchSuccess<Result>
  | KeyedBatchFailure
  | KeyedBatchSkipped;

export function batchSucceeded<Result>(args: {
  key: string;
  result: Result;
}): KeyedBatchSuccess<Result> {
  return { key: args.key, status: "succeeded", result: args.result };
}

export function batchFailed(args: {
  key: string;
  error: BatchFailure;
}): KeyedBatchFailure {
  return { key: args.key, status: "failed", error: args.error };
}

export function batchSkipped(args: {
  key: string;
  reason?: string;
}): KeyedBatchSkipped {
  return { key: args.key, status: "skipped", reason: args.reason };
}

export class BatchItemSkippedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BatchItemSkippedError";
  }
}

export function skipBatchItem(args: { reason: string }): never {
  throw new BatchItemSkippedError(args.reason);
}

export function validateKeyedBatchOutcomes<Result>(args: {
  inputKeys: readonly string[];
  outcomes: readonly KeyedBatchOutcome<Result>[];
}): readonly KeyedBatchOutcome<Result>[] {
  const expectedKeys = new Set(args.inputKeys);
  if (expectedKeys.size !== args.inputKeys.length) {
    throw new Error("Batch step input contains duplicate keys");
  }

  const seenKeys = new Set<string>();
  for (const outcome of args.outcomes) {
    if (!expectedKeys.has(outcome.key)) {
      throw new Error(`Batch step returned unknown key '${outcome.key}'`);
    }
    if (seenKeys.has(outcome.key)) {
      throw new Error(`Batch step returned duplicate key '${outcome.key}'`);
    }
    seenKeys.add(outcome.key);
  }

  const missingKeys = args.inputKeys.filter((key) => !seenKeys.has(key));
  if (missingKeys.length > 0) {
    throw new Error(`Batch step omitted keys: ${missingKeys.join(", ")}`);
  }
  return args.outcomes;
}

export interface BatchStepPolicy {
  maxItems: number;
  maxWaitMs: number;
  maxBytes?: number;
  rateLimits?: readonly BatchStepRateLimit[];
}

export interface BatchStepRateLimit {
  globalKey: string;
  partitionKey?: string;
  capacity: number;
  refillRatePerSecond: number;
  costPerItem?: number;
}

/** Physical item coalescing for calls made inside `defineBatch.process`. */
export type BatchStepDefinition<Item, Result> = {
  (input: Item): Promise<Result>;
  readonly batch: BatchStepPolicy;
  readonly partitionBy?: (input: Item) => JsonValue;
  run(args: {
    items: readonly SourceItem<Item>[];
    context: BatchExecutionContext;
  }): Promise<readonly KeyedBatchOutcome<Result>[]>;
};

export function defineBatchStep<Item, Result>(definition: {
  batch: BatchStepPolicy;
  partitionBy?: (input: Item) => JsonValue;
  run(args: {
    items: readonly SourceItem<Item>[];
    context: BatchExecutionContext;
  }): Promise<readonly KeyedBatchOutcome<Result>[]>;
}): BatchStepDefinition<Item, Result> {
  assertBatchStepPolicy(definition.batch);
  const batchStep = Object.assign(
    async (_input: Item): Promise<Result> => {
      throw new Error(
        "Batch steps are callable only inside an orchestrated defineBatch process",
      );
    },
    {
      batch: definition.batch,
      partitionBy: definition.partitionBy,
      run: definition.run,
    },
  );
  Object.defineProperty(batchStep, "kind", { value: "batch-step" });
  return batchStep;
}

export interface BatchSinkRecord<Result> {
  key: string;
  outcome: KeyedBatchOutcome<Result>;
  attempt: number;
  ordinal: number;
}

export interface BatchSinkWriteResult<State> {
  state: State;
  acknowledgedKeys: readonly string[];
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface BatchFailurePolicy {
  mode: "continue" | "fail_fast";
  maxFailures?: number;
}

export interface BatchSink<Result, State = JsonValue, Artifact = JsonValue> {
  initialize?(args: { context: BatchExecutionContext }): Promise<State>;
  writeBatch(args: {
    chunkKey: string;
    records: readonly BatchSinkRecord<Result>[];
    state?: State;
    context: BatchExecutionContext;
  }): Promise<BatchSinkWriteResult<State>>;
  finalize(args: {
    state?: State;
    summary: BatchSummary;
    context: BatchExecutionContext;
  }): Promise<Artifact>;
}

export type BatchOutput<Artifact = never> = [Artifact] extends [never]
  ? { readonly summary: BatchSummary }
  : { readonly summary: BatchSummary; readonly artifact: Artifact };

export interface BatchOptions<
  Input,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  SinkState,
  Artifact,
> {
  source(args: {
    input: Input;
    context: BatchExecutionContext;
  }):
    | BatchSourceBinding<Config, Item, Cursor, Snapshot>
    | Promise<BatchSourceBinding<Config, Item, Cursor, Snapshot>>;
  process(args: {
    key: string;
    item: Item;
    context: BatchExecutionContext;
  }): Promise<Result>;
  failurePolicy?: BatchFailurePolicy;
  sink?: BatchSink<Result, SinkState, Artifact>;
}

declare class BatchDefinitionImpl<
  Input,
  Output,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  SinkState,
  Artifact,
> {
  private declare readonly input: Input;
  private declare readonly output: Output;

  readonly source: BatchOptions<
    Input,
    Config,
    Item,
    Cursor,
    Snapshot,
    Result,
    SinkState,
    Artifact
  >["source"];
  readonly process: BatchOptions<
    Input,
    Config,
    Item,
    Cursor,
    Snapshot,
    Result,
    SinkState,
    Artifact
  >["process"];
  readonly failurePolicy?: BatchFailurePolicy;
  readonly sink?: BatchSink<Result, SinkState, Artifact>;
}

export type BatchDefinition<
  Input,
  Output,
  Config = unknown,
  Item = unknown,
  Cursor = JsonValue,
  Snapshot = JsonValue,
  Result = unknown,
  SinkState = JsonValue,
  Artifact = JsonValue,
> = BatchDefinitionImpl<
  Input,
  Output,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  SinkState,
  Artifact
>;

type ValidateBatch<
  Input,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  SinkState,
  Artifact,
> = AssertJsonCompatible<Input, "A batch input must be JSON-compatible"> &
  AssertJsonCompatible<
    BatchFailurePolicy,
    "A batch failure policy must be JSON-compatible"
  > &
  AssertJsonCompatible<
    Config,
    "A batch source config must be JSON-compatible"
  > &
  AssertJsonCompatible<Item, "A batch source item must be JSON-compatible"> &
  AssertJsonCompatible<
    Cursor,
    "A batch source cursor must be JSON-compatible"
  > &
  AssertJsonCompatible<
    Snapshot,
    "A batch source snapshot must be JSON-compatible"
  > &
  AssertJsonCompatible<
    Result,
    "A batch process result must be JSON-compatible"
  > &
  AssertJsonCompatible<
    SinkState,
    "A batch sink state must be JSON-compatible"
  > &
  ([Artifact] extends [never]
    ? unknown
    : AssertJsonCompatible<
        Artifact,
        "A batch sink artifact must be JSON-compatible"
      >);

export interface DefineBatch {
  <
    Input,
    Config,
    Item,
    Cursor = JsonValue,
    Snapshot = JsonValue,
    Result = JsonValue,
  >(
    definition: Omit<
      BatchOptions<
        Input,
        Config,
        Item,
        Cursor,
        Snapshot,
        Result,
        JsonValue,
        never
      >,
      "sink"
    > & {
      readonly sink?: never;
    } & ValidateBatch<
        Input,
        Config,
        Item,
        Cursor,
        Snapshot,
        Result,
        JsonValue,
        never
      >,
  ): BatchDefinition<
    Input,
    BatchOutput,
    Config,
    Item,
    Cursor,
    Snapshot,
    Result,
    JsonValue,
    never
  >;

  <
    Input,
    Config,
    Item,
    Cursor = JsonValue,
    Snapshot = JsonValue,
    Result = JsonValue,
    SinkState = JsonValue,
    Artifact = JsonValue,
  >(
    definition: BatchOptions<
      Input,
      Config,
      Item,
      Cursor,
      Snapshot,
      Result,
      SinkState,
      Artifact
    > & {
      readonly sink: BatchSink<Result, SinkState, Artifact>;
    } & ValidateBatch<
        Input,
        Config,
        Item,
        Cursor,
        Snapshot,
        Result,
        SinkState,
        Artifact
      >,
  ): BatchDefinition<
    Input,
    BatchOutput<Artifact>,
    Config,
    Item,
    Cursor,
    Snapshot,
    Result,
    SinkState,
    Artifact
  >;
}

export function createBatch<
  Input,
  Config,
  Item,
  Cursor = JsonValue,
  Snapshot = JsonValue,
  Result = JsonValue,
>(
  definition: Omit<
    BatchOptions<
      Input,
      Config,
      Item,
      Cursor,
      Snapshot,
      Result,
      JsonValue,
      never
    >,
    "sink"
  > & {
    readonly sink?: never;
  } & ValidateBatch<
      Input,
      Config,
      Item,
      Cursor,
      Snapshot,
      Result,
      JsonValue,
      never
    >,
): BatchDefinition<
  Input,
  BatchOutput,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  JsonValue,
  never
>;
export function createBatch<
  Input,
  Config,
  Item,
  Cursor = JsonValue,
  Snapshot = JsonValue,
  Result = JsonValue,
  SinkState = JsonValue,
  Artifact = JsonValue,
>(
  definition: BatchOptions<
    Input,
    Config,
    Item,
    Cursor,
    Snapshot,
    Result,
    SinkState,
    Artifact
  > & {
    readonly sink: BatchSink<Result, SinkState, Artifact>;
  } & ValidateBatch<
      Input,
      Config,
      Item,
      Cursor,
      Snapshot,
      Result,
      SinkState,
      Artifact
    >,
): BatchDefinition<
  Input,
  BatchOutput<Artifact>,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  SinkState,
  Artifact
>;
export function createBatch(definition: object): object {
  const failurePolicy = Reflect.get(definition, "failurePolicy");
  assertBatchFailurePolicy(failurePolicy);
  return {
    source: Reflect.get(definition, "source"),
    process: Reflect.get(definition, "process"),
    failurePolicy,
    sink: Reflect.get(definition, "sink"),
  };
}

function assertBatchFailurePolicy(failurePolicy: unknown): void {
  if (failurePolicy === undefined) return;
  if (
    typeof failurePolicy !== "object" ||
    failurePolicy === null ||
    Array.isArray(failurePolicy)
  ) {
    throw new Error("Batch failurePolicy must be an object");
  }

  const keys = Reflect.ownKeys(failurePolicy);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" || (key !== "mode" && key !== "maxFailures"),
    )
  ) {
    throw new Error(
      "Batch failurePolicy may contain only mode and maxFailures",
    );
  }

  const mode = Reflect.get(failurePolicy, "mode");
  if (mode !== "continue" && mode !== "fail_fast") {
    throw new Error("Batch failurePolicy mode must be continue or fail_fast");
  }

  const maxFailures = Reflect.get(failurePolicy, "maxFailures");
  if (
    maxFailures !== undefined &&
    (!Number.isInteger(maxFailures) || maxFailures < 1)
  ) {
    throw new Error(
      "Batch failurePolicy maxFailures must be a positive integer",
    );
  }
}

function assertBatchStepPolicy(policy: BatchStepPolicy): void {
  if (!Number.isInteger(policy.maxItems) || policy.maxItems < 1) {
    throw new Error("Batch step maxItems must be a positive integer");
  }
  if (!Number.isFinite(policy.maxWaitMs) || policy.maxWaitMs < 0) {
    throw new Error("Batch step maxWaitMs must be a non-negative number");
  }
  if (
    policy.maxBytes !== undefined &&
    (!Number.isInteger(policy.maxBytes) || policy.maxBytes < 1)
  ) {
    throw new Error("Batch step maxBytes must be a positive integer");
  }
  for (const limit of policy.rateLimits ?? []) {
    if (limit.globalKey.length === 0 || limit.globalKey.length > 500) {
      throw new Error(
        "Batch step rate limit globalKey must contain 1 to 500 characters",
      );
    }
    if (
      limit.partitionKey !== undefined &&
      (limit.partitionKey.length === 0 || limit.partitionKey.length > 500)
    ) {
      throw new Error(
        "Batch step rate limit partitionKey must contain 1 to 500 characters",
      );
    }
    assertPositiveRateValue({ name: "capacity", value: limit.capacity });
    assertPositiveRateValue({
      name: "refillRatePerSecond",
      value: limit.refillRatePerSecond,
    });
    assertPositiveRateValue({
      name: "costPerItem",
      value: limit.costPerItem ?? 1,
    });
    if ((limit.costPerItem ?? 1) * policy.maxItems > limit.capacity) {
      throw new Error(
        "Batch step rate limit capacity must cover one full cohort",
      );
    }
  }
}

function assertPositiveRateValue(args: { name: string; value: number }): void {
  if (!Number.isFinite(args.value) || args.value <= 0) {
    throw new Error(`Batch step rate limit ${args.name} must be positive`);
  }
}
