import { pathToFileURL } from "node:url";
import type { ResolvedRuntimeInvocation } from "./supervisor-dispatcher.js";
import type {
  RuntimeBatchStepSuspension,
  RuntimeStepEntry,
  RuntimeTerminalResult,
} from "./supervisor-protocol.js";
import {
  parseRuntimeInvocationRequest,
  toProtocolJson,
} from "./supervisor-protocol.js";

type WorkerRunStep = (
  nodeId: string,
  name: string,
  fn: (input: unknown) => unknown | Promise<unknown>,
  input: unknown,
  functionName?: string,
) => Promise<unknown>;

const invocationAbortController = new AbortController();
let initialized = false;

process.on("message", (message: unknown) => {
  if (!isRecord(message)) return;
  if (message.type === "abort") {
    invocationAbortController.abort(
      new Error(
        typeof message.reason === "string"
          ? message.reason
          : "Invocation was aborted",
      ),
    );
    return;
  }
  if (message.type !== "init") return;
  if (initialized) {
    void reportInfrastructureError(
      new Error("Invocation child can only be initialized once"),
    );
    return;
  }
  initialized = true;
  void runInvocation(message.invocation)
    .then((terminal) => sendToParent({ type: "terminal", terminal }))
    .then(disconnectParent)
    .catch(reportInfrastructureError);
});

async function runInvocation(value: unknown): Promise<RuntimeTerminalResult> {
  const invocation = parseResolvedInvocation(value);
  const steps: RuntimeStepEntry[] = [];
  installStepRecorder({ invocation, steps });

  try {
    const moduleUrl = pathToFileURL(invocation.absoluteModulePath);
    moduleUrl.searchParams.set(
      "catamorphicInvocation",
      invocation.invocationId,
    );
    const moduleExports: unknown = await import(moduleUrl.href);
    Reflect.set(globalThis, "__catamorphicModuleExports", moduleExports);
    const result = await executeInvocationTarget({
      moduleExports,
      invocation,
    });
    return {
      status: "completed",
      result: toProtocolJson(result),
      steps,
    };
  } catch (error) {
    if (error instanceof InvocationChildInfrastructureError) throw error;
    if (error instanceof BatchStepSuspensionError) {
      return {
        status: "suspended",
        suspension: error.suspension,
        steps,
      };
    }
    if (error instanceof Error && error.name === "BatchItemSkippedError") {
      return {
        status: "skipped",
        reason: error.message,
        steps,
      };
    }
    const retryAfterMs = rateLimitRetryAfter(error);
    if (retryAfterMs !== undefined) {
      failRunningSteps({ steps });
      return {
        status: "rate_limited",
        retryAfterMs,
        error: error instanceof Error ? error.message : String(error),
        steps,
      };
    }
    failRunningSteps({ steps });
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      steps,
    };
  }
}

async function executeInvocationTarget(args: {
  moduleExports: unknown;
  invocation: ResolvedRuntimeInvocation;
}): Promise<unknown> {
  if (!isRecord(args.moduleExports)) {
    throw new Error("Invocation target module did not export an object");
  }
  const exported = Reflect.get(
    args.moduleExports,
    args.invocation.target.exportName,
  );
  const context = {
    invocationId: args.invocation.invocationId,
    attempt: args.invocation.attempt,
    deadlineAt: args.invocation.deadlineAt,
    signal: invocationAbortController.signal,
  };

  if (args.invocation.kind === "batch-source") {
    const definition = requireBatchDefinition({
      exported,
      stepIndex: requireTargetStepIndex({ target: args.invocation.target }),
    });
    const input = requireRecordInput(args.invocation.input);
    const source = requireFunctionProperty({
      value: definition,
      property: "source",
      description: "Batch definition source",
    });
    const binding = await Reflect.apply(source, definition, [
      { input: input.workflowInput, context },
    ]);
    if (!isRecord(binding) || !isRecord(binding.source)) {
      throw new Error("Batch definition source returned an invalid binding");
    }
    if (args.invocation.target.operation === "initialize") {
      const initialize = Reflect.get(binding.source, "initialize");
      if (typeof initialize !== "function") {
        throw new Error("Batch source does not implement initialize");
      }
      const initialized = await Reflect.apply(initialize, binding.source, [
        { config: binding.config, context },
      ]);
      if (!isRecord(initialized)) {
        throw new Error("Batch source initialize returned an invalid result");
      }
      return {
        ...initialized,
        consistency: Reflect.get(binding.source, "consistency"),
      };
    }
    if (args.invocation.target.operation === "readPage") {
      const readPage = Reflect.get(binding.source, "readPage");
      if (typeof readPage !== "function") {
        throw new Error("Batch source does not implement readPage");
      }
      return Reflect.apply(readPage, binding.source, [
        {
          config: binding.config,
          snapshot: input.snapshot,
          cursor: input.cursor,
          limit: input.limit,
          context,
        },
      ]);
    }
    throw new Error("Batch source operation must be initialize or readPage");
  }

  if (args.invocation.kind === "durable-boundary") {
    const boundary = requireWorkflowStep({
      exported,
      stepIndex: requireTargetStepIndex({ target: args.invocation.target }),
    });
    const input = requireRecordInput(args.invocation.input);
    const run = requireFunctionProperty({
      value: boundary,
      property: "run",
      description: "Boundary definition run callback",
    });
    const pause = (
      options?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      __catamorphicDurableTransition: "pause",
      ...(typeof options?.timeout === "string"
        ? { timeout: options.timeout }
        : {}),
      ...(typeof options?.signal === "string" && options.signal.length > 0
        ? { signal: options.signal }
        : {}),
      statePresent: options ? Object.hasOwn(options, "state") : false,
      ...(options && Object.hasOwn(options, "state")
        ? { state: options.state }
        : {}),
    });
    const callWorkflow = (
      _workflow: unknown,
      options: Record<string, unknown>,
      metadata?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      __catamorphicDurableTransition: "child_workflow",
      input: options.input,
      ...(metadata ? { workflow: metadata } : {}),
    });
    const returned = await Reflect.apply(run, boundary, [
      { input: input.value, pause, callWorkflow },
    ]);
    const safe = strictJson({
      value: returned,
      path: "Durable boundary result",
    });
    if (
      isRecord(safe) &&
      (safe.__catamorphicDurableTransition === "pause" ||
        safe.__catamorphicDurableTransition === "child_workflow")
    ) {
      return { type: safe.__catamorphicDurableTransition, transition: safe };
    }
    return { type: "completed", output: safe };
  }

  if (
    args.invocation.kind === "batch-step" &&
    args.invocation.target.operation === "process"
  ) {
    const definition = requireBatchDefinition({
      exported,
      stepIndex: requireTargetStepIndex({ target: args.invocation.target }),
    });
    const process = requireFunctionProperty({
      value: definition,
      property: "process",
      description: "Batch definition process",
    });
    const input = requireRecordInput(args.invocation.input);
    return Reflect.apply(process, definition, [
      {
        key: input.key,
        item: input.item,
        context,
      },
    ]);
  }

  if (
    args.invocation.kind === "batch-step" &&
    args.invocation.target.operation === "run"
  ) {
    const batchStep = requireExportedBatchStep(exported);
    const input = requireRecordInput(args.invocation.input);
    return Reflect.apply(batchStep.run, exported, [
      { items: input.items, context },
    ]);
  }

  if (args.invocation.kind === "batch-sink") {
    const definition = requireBatchDefinition({
      exported,
      stepIndex: requireTargetStepIndex({ target: args.invocation.target }),
    });
    const sink = Reflect.get(definition, "sink");
    const operation = args.invocation.target.operation;
    if (operation === "inspect") {
      const concurrency = isRecord(sink)
        ? Reflect.get(sink, "concurrency")
        : undefined;
      return {
        present: isRecord(sink),
        hasInitialize:
          isRecord(sink) &&
          typeof Reflect.get(sink, "initialize") === "function",
        concurrency: typeof concurrency === "number" ? concurrency : 1,
      };
    }
    if (!isRecord(sink)) throw new Error("Batch definition has no sink");
    const target = operation ? Reflect.get(sink, operation) : undefined;
    if (typeof target !== "function") {
      throw new Error(`Batch sink does not implement '${operation ?? ""}'`);
    }
    return Reflect.apply(target, sink, [
      { ...requireRecordInput(args.invocation.input), context },
    ]);
  }

  throw new Error(
    `Invocation kind '${String(args.invocation.kind)}' is not supported`,
  );
}

function requireWorkflowStep(args: {
  exported: unknown;
  stepIndex: number;
}): Record<string, unknown> {
  if (!isRecord(args.exported)) {
    throw new Error("Invocation target is not a defined workflow");
  }
  const steps = Reflect.get(args.exported, "steps");
  if (!Array.isArray(steps)) {
    throw new Error("Defined workflow steps are invalid");
  }
  const step = steps[args.stepIndex];
  if (!isRecord(step)) {
    throw new Error(`Defined workflow step ${args.stepIndex} is invalid`);
  }
  return step;
}

function requireTargetStepIndex(args: {
  target: { stepIndex?: number };
}): number {
  if (args.target.stepIndex === undefined) {
    throw new Error("Invocation target requires stepIndex");
  }
  return args.target.stepIndex;
}

function requireBatchDefinition(args: {
  exported: unknown;
  stepIndex: number;
}): Record<string, unknown> {
  const definition = requireWorkflowStep(args);
  if (
    typeof Reflect.get(definition, "source") !== "function" ||
    typeof Reflect.get(definition, "process") !== "function"
  ) {
    throw new Error(`Defined workflow step ${args.stepIndex} is not a batch`);
  }
  return definition;
}

function requireFunctionProperty(args: {
  value: Record<string, unknown>;
  property: string;
  description: string;
}): (...values: unknown[]) => unknown {
  const fn = Reflect.get(args.value, args.property);
  if (typeof fn !== "function") {
    throw new Error(`${args.description} is invalid`);
  }
  return (...values) => Reflect.apply(fn, args.value, values);
}

function requireExportedBatchStep(value: unknown): {
  run: (...values: unknown[]) => unknown;
} {
  if (
    (typeof value !== "function" && !isRecord(value)) ||
    Reflect.get(value, "kind") !== "batch-step" ||
    typeof Reflect.get(value, "run") !== "function" ||
    !isRecord(Reflect.get(value, "batch"))
  ) {
    throw new Error("Batch step export is invalid");
  }
  const run = Reflect.get(value, "run");
  return { run: (...values) => Reflect.apply(run, value, values) };
}

function requireRecordInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invocation input must be an object");
  return value;
}

function installStepRecorder(args: {
  invocation: ResolvedRuntimeInvocation;
  steps: RuntimeStepEntry[];
}): void {
  const occurrences = new Map<string, number>();
  const replay = readReplay(args.invocation);
  const runStep: WorkerRunStep = async (
    nodeId,
    name,
    fn,
    input,
    functionName,
  ) => {
    const startedAt = new Date().toISOString();
    const occurrence = occurrences.get(nodeId) ?? 0;
    occurrences.set(nodeId, occurrence + 1);
    const replayKey = `${nodeId}:${occurrence}`;
    if (replay.has(replayKey)) {
      const output = replay.get(replayKey);
      args.steps.push({
        nodeId,
        occurrence,
        name,
        status: "completed",
        attempt: args.invocation.attempt,
        input: toProtocolJson(input),
        output: toProtocolJson(output),
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return output;
    }
    const batchStep = resolveBatchStep(functionName);
    if (batchStep) {
      const partition = batchStep.partitionBy
        ? toProtocolJson(batchStep.partitionBy(input))
        : undefined;
      throw new BatchStepSuspensionError({
        nodeId,
        occurrence,
        name,
        functionName: functionName ?? "",
        input: toProtocolJson(input),
        partition,
        policy: batchStep.batch,
      });
    }
    await sendToParent({
      type: "event",
      event: {
        type: "step_started",
        nodeId,
        occurrence,
        name,
        input: toProtocolJson(input),
      },
    });
    try {
      const output = await fn(input);
      const safeOutput = toProtocolJson(output);
      args.steps.push({
        nodeId,
        occurrence,
        name,
        status: "completed",
        attempt: args.invocation.attempt,
        input: toProtocolJson(input),
        output: safeOutput,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      await sendToParent({
        type: "event",
        event: {
          type: "step_completed",
          nodeId,
          occurrence,
          name,
          output: safeOutput,
        },
      });
      return output;
    } catch (error) {
      if (error instanceof InvocationChildInfrastructureError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      args.steps.push({
        nodeId,
        occurrence,
        name,
        status: "failed",
        attempt: args.invocation.attempt,
        input: toProtocolJson(input),
        error: message,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      await sendToParent({
        type: "event",
        event: {
          type: "step_failed",
          nodeId,
          occurrence,
          name,
          error: message,
        },
      });
      throw error;
    }
  };
  Reflect.set(globalThis, "__catamorphicRunStep", runStep);
  Reflect.set(globalThis, "__catamorphicInvocation", {
    invocationId: args.invocation.invocationId,
    workingDirectory: args.invocation.workingDirectory,
    deadlineAt: args.invocation.deadlineAt,
    attempt: args.invocation.attempt,
    traceContext: args.invocation.traceContext,
  });
}

class BatchStepSuspensionError extends Error {
  constructor(readonly suspension: RuntimeBatchStepSuspension) {
    super(`Batch step '${suspension.name}' is waiting for a cohort`);
    this.name = "BatchStepSuspensionError";
  }
}

class InvocationChildInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvocationChildInfrastructureError";
  }
}

function resolveBatchStep(functionName: string | undefined): {
  batch: RuntimeBatchStepSuspension["policy"];
  partitionBy?: (input: unknown) => unknown;
} | null {
  if (!functionName) return null;
  const moduleExports = Reflect.get(globalThis, "__catamorphicModuleExports");
  if (!isRecord(moduleExports)) return null;
  const exported = Reflect.get(moduleExports, functionName);
  if (!isRecord(exported) && typeof exported !== "function") return null;
  if (Reflect.get(exported, "kind") !== "batch-step") return null;
  const batch = Reflect.get(exported, "batch");
  const partitionBy = Reflect.get(exported, "partitionBy");
  if (
    !isRecord(batch) ||
    typeof batch.maxItems !== "number" ||
    typeof batch.maxWaitMs !== "number"
  ) {
    throw new Error(`Batch step '${functionName}' has an invalid policy`);
  }
  return {
    batch: {
      maxItems: batch.maxItems,
      maxWaitMs: batch.maxWaitMs,
      maxBytes: typeof batch.maxBytes === "number" ? batch.maxBytes : undefined,
      rateLimits: readBatchStepRateLimits(batch.rateLimits),
    },
    partitionBy:
      typeof partitionBy === "function"
        ? (input) => Reflect.apply(partitionBy, exported, [input])
        : undefined,
  };
}

function readBatchStepRateLimits(
  value: unknown,
): RuntimeBatchStepSuspension["policy"]["rateLimits"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Batch step rateLimits must be an array");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.globalKey !== "string" ||
      typeof entry.capacity !== "number" ||
      typeof entry.refillRatePerSecond !== "number"
    ) {
      throw new Error("Batch step rate limit is invalid");
    }
    return {
      globalKey: entry.globalKey,
      capacity: entry.capacity,
      refillRatePerSecond: entry.refillRatePerSecond,
      ...(typeof entry.partitionKey === "string"
        ? { partitionKey: entry.partitionKey }
        : {}),
      ...(typeof entry.costPerItem === "number"
        ? { costPerItem: entry.costPerItem }
        : {}),
    };
  });
}

function readReplay(
  invocation: ResolvedRuntimeInvocation,
): ReadonlyMap<string, unknown> {
  const replay =
    invocation.replay ??
    (isRecord(invocation.input)
      ? Reflect.get(invocation.input, "replay")
      : undefined);
  if (!isRecord(replay)) return new Map();
  return new Map(Object.entries(replay));
}

function parseResolvedInvocation(value: unknown): ResolvedRuntimeInvocation {
  const request = parseRuntimeInvocationRequest(value);
  if (!isRecord(value)) {
    throw new Error("Resolved invocation must be an object");
  }
  if (
    typeof value.absoluteModulePath !== "string" ||
    value.absoluteModulePath === ""
  ) {
    throw new Error("Resolved invocation requires absoluteModulePath");
  }
  if (
    typeof value.workingDirectory !== "string" ||
    value.workingDirectory === ""
  ) {
    throw new Error("Resolved invocation requires workingDirectory");
  }
  return {
    ...request,
    absoluteModulePath: value.absoluteModulePath,
    workingDirectory: value.workingDirectory,
  };
}

function failRunningSteps(args: { steps: RuntimeStepEntry[] }): void {
  const completedAt = new Date().toISOString();
  for (const step of args.steps) {
    if (step.completedAt !== "") continue;
    step.status = "failed";
    step.error = "Workflow ended before the step completed";
    step.completedAt = completedAt;
  }
}

// Matched structurally: workflow code runs in the sandbox against its own copy
// of @catamorphic/workflow, so `instanceof` cannot be used across that boundary.
function rateLimitRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof Error) || error.name !== "RateLimitedError") {
    return undefined;
  }
  const retryAfterMs = Reflect.get(error, "retryAfterMs");
  return typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
    ? retryAfterMs
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function strictJson(args: { value: unknown; path: string }): unknown {
  if (
    args.value === null ||
    typeof args.value === "string" ||
    typeof args.value === "boolean"
  ) {
    return args.value;
  }
  if (typeof args.value === "number") {
    if (!Number.isFinite(args.value)) {
      throw new Error(`${args.path} must be finite JSON`);
    }
    return args.value;
  }
  if (Array.isArray(args.value)) {
    return args.value.map((entry, index) =>
      strictJson({ value: entry, path: `${args.path}[${index}]` }),
    );
  }
  if (!isRecord(args.value) || args.value instanceof Date) {
    throw new Error(`${args.path} must be JSON-compatible`);
  }
  return Object.fromEntries(
    Object.entries(args.value).map(([key, entry]) => {
      if (entry === undefined) {
        throw new Error(`${args.path}.${key} must not be undefined`);
      }
      return [key, strictJson({ value: entry, path: `${args.path}.${key}` })];
    }),
  );
}

function sendToParent(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(
        new InvocationChildInfrastructureError(
          "Invocation child requires a parent IPC channel",
        ),
      );
      return;
    }
    process.send(message, (error) => {
      if (error) {
        reject(
          new InvocationChildInfrastructureError(
            "Invocation child failed to send an IPC message",
            { cause: error },
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function reportInfrastructureError(error: unknown): Promise<void> {
  process.exitCode = 1;
  try {
    await sendToParent({
      type: "infrastructure_error",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  } finally {
    disconnectParent();
  }
}

function disconnectParent(): void {
  if (process.connected && process.disconnect) process.disconnect();
}
