export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

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

export interface SourcePage<Item, Cursor extends JsonValue> {
  items: readonly SourceItem<Item>[];
  nextCursor?: Cursor;
  done: boolean;
}

export interface SourceInitialization<
  Cursor extends JsonValue,
  Snapshot extends JsonValue,
> {
  snapshot: Snapshot;
  cursor?: Cursor;
  estimatedCount?: number;
}

export interface BatchSource<
  Config,
  Item,
  Cursor extends JsonValue = JsonValue,
  Snapshot extends JsonValue = JsonValue,
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
  Cursor extends JsonValue = JsonValue,
  Snapshot extends JsonValue = JsonValue,
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

export type BatchStepDefinition<Item, Result> = {
  (input: Item): Promise<Result>;
  readonly kind: "batch-step";
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
  const kind: "batch-step" = "batch-step";
  return Object.assign(
    async (_input: Item): Promise<Result> => {
      throw new Error(
        "Batch steps are callable only inside an orchestrated batch workflow",
      );
    },
    {
      kind,
      batch: definition.batch,
      partitionBy: definition.partitionBy,
      run: definition.run,
    },
  );
}

export interface BatchSinkRecord<Result> {
  key: string;
  outcome: KeyedBatchOutcome<Result>;
  attempt: number;
  ordinal: number;
}

export interface BatchSinkWriteResult<State extends JsonValue> {
  state: State;
  acknowledgedKeys: readonly string[];
}

export interface BatchSinkSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface BatchSink<
  Result,
  State extends JsonValue = JsonValue,
  Artifact extends JsonValue = JsonValue,
> {
  initialize?(args: { context: BatchExecutionContext }): Promise<State>;
  writeBatch(args: {
    chunkKey: string;
    records: readonly BatchSinkRecord<Result>[];
    state?: State;
    context: BatchExecutionContext;
  }): Promise<BatchSinkWriteResult<State>>;
  finalize(args: {
    state?: State;
    summary: BatchSinkSummary;
    context: BatchExecutionContext;
  }): Promise<Artifact>;
}

export interface BatchWorkflowDefinition<
  Input,
  Config,
  Item,
  Cursor extends JsonValue,
  Snapshot extends JsonValue,
  Result,
  SinkState extends JsonValue,
  Artifact extends JsonValue,
> {
  readonly kind: "batch-workflow";
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
  sink?: BatchSink<Result, SinkState, Artifact>;
}

export function defineBatchWorkflow<
  Input,
  Config,
  Item,
  Cursor extends JsonValue = JsonValue,
  Snapshot extends JsonValue = JsonValue,
  Result = unknown,
  SinkState extends JsonValue = JsonValue,
  Artifact extends JsonValue = JsonValue,
>(
  definition: Omit<
    BatchWorkflowDefinition<
      Input,
      Config,
      Item,
      Cursor,
      Snapshot,
      Result,
      SinkState,
      Artifact
    >,
    "kind"
  >,
): BatchWorkflowDefinition<
  Input,
  Config,
  Item,
  Cursor,
  Snapshot,
  Result,
  SinkState,
  Artifact
> {
  return { kind: "batch-workflow", ...definition };
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
    assertPositiveRateValue({
      name: "capacity",
      value: limit.capacity,
    });
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
