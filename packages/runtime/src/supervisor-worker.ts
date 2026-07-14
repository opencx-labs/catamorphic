import { pathToFileURL } from "node:url";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
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

type InvocationTargetFunction = (input: unknown) => unknown;

const port = requireParentPort(parentPort);

void runInvocation()
  .then((terminal) => {
    port.postMessage({ type: "terminal", terminal });
  })
  .catch((error) => {
    port.postMessage({
      type: "terminal",
      terminal: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        steps: [],
      },
    });
  });

async function runInvocation(): Promise<RuntimeTerminalResult> {
  const invocation = parseResolvedInvocation(workerData);
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
    signal: new AbortController().signal,
  };

  if (args.invocation.kind === "batch-source") {
    const definition = requireBatchWorkflow(exported);
    const input = requireRecordInput(args.invocation.input);
    const binding = await Reflect.apply(definition.source, definition, [
      { input: input.workflowInput, context },
    ]);
    if (!isRecord(binding) || !isRecord(binding.source)) {
      throw new Error("Batch workflow source returned an invalid binding");
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

  if (
    args.invocation.kind === "batch-step" &&
    isRecord(exported) &&
    exported.kind === "batch-workflow" &&
    args.invocation.target.operation === "process"
  ) {
    const process = Reflect.get(exported, "process");
    if (typeof process !== "function") {
      throw new Error("Batch workflow does not implement process");
    }
    const input = requireRecordInput(args.invocation.input);
    return Reflect.apply(process, exported, [
      {
        key: input.key,
        item: input.item,
        context,
      },
    ]);
  }

  if (
    args.invocation.kind === "batch-step" &&
    (isRecord(exported) || typeof exported === "function")
  ) {
    const run = Reflect.get(exported, "run");
    if (
      Reflect.get(exported, "kind") !== "batch-step" ||
      typeof run !== "function"
    ) {
      throw new Error("Batch step export is invalid");
    }
    const input = requireRecordInput(args.invocation.input);
    return Reflect.apply(run, exported, [{ items: input.items, context }]);
  }

  if (
    args.invocation.kind === "batch-sink" &&
    isRecord(exported) &&
    exported.kind === "batch-workflow"
  ) {
    const sink = Reflect.get(exported, "sink");
    const operation = args.invocation.target.operation;
    if (operation === "inspect") {
      return {
        present: isRecord(sink),
        hasInitialize:
          isRecord(sink) &&
          typeof Reflect.get(sink, "initialize") === "function",
      };
    }
    if (!isRecord(sink)) throw new Error("Batch workflow has no sink");
    const target = operation ? Reflect.get(sink, operation) : undefined;
    if (typeof target !== "function") {
      throw new Error(`Batch sink does not implement '${operation ?? ""}'`);
    }
    return Reflect.apply(target, sink, [
      { ...requireRecordInput(args.invocation.input), context },
    ]);
  }

  const target = resolveTarget({
    moduleExports: args.moduleExports,
    exportName: args.invocation.target.exportName,
    operation: args.invocation.target.operation,
  });
  return Reflect.apply(target, undefined, [args.invocation.input]);
}

function requireBatchWorkflow(value: unknown): {
  source: (args: unknown) => unknown;
} {
  if (!isRecord(value) || value.kind !== "batch-workflow") {
    throw new Error("Invocation target is not a batch workflow");
  }
  const source = Reflect.get(value, "source");
  if (typeof source !== "function") {
    throw new Error("Batch workflow does not implement source");
  }
  return {
    source: (args) => Reflect.apply(source, value, [args]),
  };
}

function requireRecordInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Batch invocation input is invalid");
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
        name,
        functionName: functionName ?? "",
        input: toProtocolJson(input),
        partition,
        policy: batchStep.batch,
      });
    }
    port.postMessage({
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
      port.postMessage({
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
      port.postMessage({
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

function resolveTarget(args: {
  moduleExports: unknown;
  exportName: string;
  operation?: string;
}): InvocationTargetFunction {
  if (!isRecord(args.moduleExports)) {
    throw new Error("Invocation target module did not export an object");
  }
  const exported = Reflect.get(args.moduleExports, args.exportName);
  const target =
    args.operation === undefined
      ? exported
      : isRecord(exported)
        ? Reflect.get(exported, args.operation)
        : undefined;
  if (typeof target !== "function") {
    const suffix = args.operation ? `.${args.operation}` : "";
    throw new Error(
      `'${args.exportName}${suffix}' is not exported as a function`,
    );
  }
  return (input) => Reflect.apply(target, undefined, [input]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireParentPort(value: MessagePort | null): MessagePort {
  if (!value) {
    throw new Error("Supervisor worker requires a parent message port");
  }
  return value;
}
