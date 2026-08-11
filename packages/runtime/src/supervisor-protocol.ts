import type { BatchStepRateLimit, JsonValue } from "@catamorphic/workflow";

export const RUNTIME_PROTOCOL_VERSION = 8;
export const DEPLOYMENT_RUNTIME_VERSION = `runtime-protocol-v${RUNTIME_PROTOCOL_VERSION}`;

export interface RuntimeArtifactIdentity {
  deploymentArtifactId: string;
  artifactDigest: string;
  transformVersion: string;
  runtimeVersion: string;
}

export type RuntimeWorkKind =
  | "durable-boundary"
  | "batch-source"
  | "batch-step"
  | "batch-sink";

interface RuntimeInvocationTargetBase {
  modulePath: string;
  exportName: string;
}

export interface RuntimeBoundaryTarget extends RuntimeInvocationTargetBase {
  stepIndex: number;
  operation?: never;
}

export interface RuntimeBatchSourceTarget extends RuntimeInvocationTargetBase {
  stepIndex: number;
  operation: "initialize" | "readPage";
}

export interface RuntimeBatchProcessTarget extends RuntimeInvocationTargetBase {
  stepIndex: number;
  operation: "process";
}

export interface RuntimeBatchStepTarget extends RuntimeInvocationTargetBase {
  stepIndex?: never;
  operation: "run";
}

export interface RuntimeBatchSinkTarget extends RuntimeInvocationTargetBase {
  stepIndex: number;
  operation: "inspect" | "initialize" | "writeBatch" | "finalize";
}

export type RuntimeInvocationTarget =
  | RuntimeBoundaryTarget
  | RuntimeBatchSourceTarget
  | RuntimeBatchProcessTarget
  | RuntimeBatchStepTarget
  | RuntimeBatchSinkTarget;

interface RuntimeInvocationRequestBase extends RuntimeArtifactIdentity {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /**
   * Idempotency identity for one logical execution. Redelivery must reuse this
   * value; an intentional re-execution must use a new value.
   */
  invocationId: string;
  input: unknown;
  attempt: number;
  deadlineAt: string;
  replay?: Record<string, unknown>;
  env?: Record<string, string>;
  traceContext?: Record<string, string>;
}

export type RuntimeInvocationRequest =
  | (RuntimeInvocationRequestBase & {
      kind: "durable-boundary";
      target: RuntimeBoundaryTarget;
    })
  | (RuntimeInvocationRequestBase & {
      kind: "batch-source";
      target: RuntimeBatchSourceTarget;
    })
  | (RuntimeInvocationRequestBase & {
      kind: "batch-step";
      target: RuntimeBatchProcessTarget | RuntimeBatchStepTarget;
    })
  | (RuntimeInvocationRequestBase & {
      kind: "batch-sink";
      target: RuntimeBatchSinkTarget;
    });

export interface RuntimeStepEntry {
  nodeId: string;
  occurrence: number;
  name: string;
  status: "completed" | "failed";
  attempt: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface RuntimeBatchStepSuspension {
  nodeId: string;
  occurrence: number;
  name: string;
  functionName: string;
  input: unknown;
  partition?: unknown;
  policy: {
    maxItems: number;
    maxWaitMs: number;
    maxBytes?: number;
    rateLimits?: readonly BatchStepRateLimit[];
  };
}

interface RuntimeInvocationEventBase {
  invocationId: string;
  sequence: number;
  attempt: number;
  timestamp: string;
}

export type RuntimeInvocationEvent =
  | (RuntimeInvocationEventBase & { type: "accepted" })
  | (RuntimeInvocationEventBase & {
      type: "started";
    })
  | (RuntimeInvocationEventBase & {
      type: "step_started";
      nodeId: string;
      occurrence: number;
      name: string;
      input?: unknown;
    })
  | (RuntimeInvocationEventBase & {
      type: "step_completed";
      nodeId: string;
      occurrence: number;
      name: string;
      output?: unknown;
    })
  | (RuntimeInvocationEventBase & {
      type: "step_failed";
      nodeId: string;
      occurrence: number;
      name: string;
      error: string;
    })
  | (RuntimeInvocationEventBase & {
      type: "completed";
      result?: unknown;
    })
  | (RuntimeInvocationEventBase & {
      type: "suspended";
      suspension: RuntimeBatchStepSuspension;
    })
  | (RuntimeInvocationEventBase & {
      type: "skipped";
      reason: string;
    })
  | (RuntimeInvocationEventBase & {
      type: "rate_limited";
      retryAfterMs: number;
      error: string;
    })
  | (RuntimeInvocationEventBase & {
      type: "failed" | "canceled" | "timed_out";
      error: string;
    });

export type RuntimeTerminalResult =
  | {
      status: "completed";
      result?: unknown;
      steps: readonly RuntimeStepEntry[];
    }
  | {
      status: "suspended";
      suspension: RuntimeBatchStepSuspension;
      steps: readonly RuntimeStepEntry[];
    }
  | {
      status: "skipped";
      reason: string;
      steps: readonly RuntimeStepEntry[];
    }
  | {
      status: "rate_limited";
      retryAfterMs: number;
      error: string;
      steps: readonly RuntimeStepEntry[];
    }
  | {
      status: "failed" | "canceled" | "timed_out";
      error: string;
      steps: readonly RuntimeStepEntry[];
    };

export interface RuntimeInvocationResponse {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
  terminal: RuntimeTerminalResult;
}

export interface RuntimeInvocationEventsResponse {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
  done: boolean;
}

export interface RuntimeSupervisorHealth {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  status: "healthy";
  activeInvocations: number;
  queuedInvocations: number;
  maxConcurrency: number;
}

export interface RuntimeProtocolErrorBody {
  error: {
    code:
      | "bad_request"
      | "unauthorized"
      | "not_found"
      | "conflict"
      | "internal_error";
    message: string;
  };
}

export function parseRuntimeInvocationRequest(
  value: unknown,
): RuntimeInvocationRequest {
  if (!isRecord(value)) {
    throw new Error("Invocation body must be an object");
  }
  if (value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Invocation protocolVersion must be ${RUNTIME_PROTOCOL_VERSION}`,
    );
  }
  const invocationId = requireNonEmptyString({
    value: value.invocationId,
    field: "invocationId",
  });
  const deploymentArtifactId = requireNonEmptyString({
    value: value.deploymentArtifactId,
    field: "deploymentArtifactId",
  });
  const artifactDigest = requireNonEmptyString({
    value: value.artifactDigest,
    field: "artifactDigest",
  });
  const transformVersion = requireNonEmptyString({
    value: value.transformVersion,
    field: "transformVersion",
  });
  const runtimeVersion = requireNonEmptyString({
    value: value.runtimeVersion,
    field: "runtimeVersion",
  });
  if (!isRuntimeWorkKind(value.kind)) {
    throw new Error("Invocation kind is invalid");
  }
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1) {
    throw new Error("Invocation attempt must be a positive integer");
  }
  const deadlineAt = requireNonEmptyString({
    value: value.deadlineAt,
    field: "deadlineAt",
  });
  if (Number.isNaN(Date.parse(deadlineAt))) {
    throw new Error("Invocation deadlineAt must be an ISO date");
  }
  const env = parseEnvironment(value.env);
  const traceContext = parseEnvironment(value.traceContext);
  const replay = parseReplay(value.replay);

  const request: RuntimeInvocationRequestBase = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId,
    deploymentArtifactId,
    artifactDigest,
    transformVersion,
    runtimeVersion,
    input: value.input,
    attempt: Number(value.attempt),
    deadlineAt,
    replay,
    env,
    traceContext,
  };
  if (value.kind === "durable-boundary") {
    return {
      ...request,
      kind: value.kind,
      target: parseTarget({ value: value.target, kind: value.kind }),
    };
  }
  if (value.kind === "batch-source") {
    return {
      ...request,
      kind: value.kind,
      target: parseTarget({ value: value.target, kind: value.kind }),
    };
  }
  if (value.kind === "batch-step") {
    return {
      ...request,
      kind: value.kind,
      target: parseTarget({ value: value.target, kind: value.kind }),
    };
  }
  return {
    ...request,
    kind: value.kind,
    target: parseTarget({ value: value.target, kind: value.kind }),
  };
}

function parseReplay(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invocation replay must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

export function toProtocolJson(value: unknown): JsonValue {
  return toProtocolJsonValue({ value, seen: new WeakSet<object>() });
}

function parseTarget(args: {
  value: unknown;
  kind: "durable-boundary";
}): RuntimeBoundaryTarget;
function parseTarget(args: {
  value: unknown;
  kind: "batch-source";
}): RuntimeBatchSourceTarget;
function parseTarget(args: {
  value: unknown;
  kind: "batch-step";
}): RuntimeBatchProcessTarget | RuntimeBatchStepTarget;
function parseTarget(args: {
  value: unknown;
  kind: "batch-sink";
}): RuntimeBatchSinkTarget;
function parseTarget(args: {
  value: unknown;
  kind: RuntimeWorkKind;
}): RuntimeInvocationTarget {
  if (!isRecord(args.value)) {
    throw new Error("Invocation target must be an object");
  }
  const modulePath = requireNonEmptyString({
    value: args.value.modulePath,
    field: "target.modulePath",
  });
  if (modulePath.includes("\0")) {
    throw new Error("Invocation target.modulePath contains a null byte");
  }
  const exportName = requireNonEmptyString({
    value: args.value.exportName,
    field: "target.exportName",
  });
  const operation =
    args.value.operation === undefined
      ? undefined
      : requireNonEmptyString({
          value: args.value.operation,
          field: "target.operation",
        });
  const stepIndex = parseStepIndex(args.value.stepIndex);
  const base = { modulePath, exportName };

  if (args.kind === "durable-boundary") {
    requireOperation({ operation, expected: undefined, kind: args.kind });
    return {
      ...base,
      stepIndex: requireStepIndex({ stepIndex, kind: args.kind }),
    };
  }
  if (args.kind === "batch-source") {
    if (operation !== "initialize" && operation !== "readPage") {
      throw new Error(
        "Invocation batch-source target.operation must be initialize or readPage",
      );
    }
    return {
      ...base,
      stepIndex: requireStepIndex({ stepIndex, kind: args.kind }),
      operation,
    };
  }
  if (args.kind === "batch-step" && operation === "process") {
    return {
      ...base,
      stepIndex: requireStepIndex({ stepIndex, kind: args.kind }),
      operation,
    };
  }
  if (args.kind === "batch-step" && operation === "run") {
    requireNoStepIndex({ stepIndex, kind: "physical batch-step" });
    return { ...base, operation };
  }
  if (args.kind === "batch-step") {
    throw new Error(
      "Invocation batch-step target.operation must be process or run",
    );
  }
  if (
    operation !== "inspect" &&
    operation !== "initialize" &&
    operation !== "writeBatch" &&
    operation !== "finalize"
  ) {
    throw new Error("Invocation batch-sink target.operation is invalid");
  }
  return {
    ...base,
    stepIndex: requireStepIndex({ stepIndex, kind: args.kind }),
    operation,
  };
}

function parseStepIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(
      "Invocation target.stepIndex must be a non-negative integer",
    );
  }
  return Number(value);
}

function requireStepIndex(args: {
  stepIndex: number | undefined;
  kind: string;
}): number {
  if (args.stepIndex === undefined) {
    throw new Error(`Invocation ${args.kind} target requires stepIndex`);
  }
  return args.stepIndex;
}

function requireNoStepIndex(args: {
  stepIndex: number | undefined;
  kind: string;
}): void {
  if (args.stepIndex !== undefined) {
    throw new Error(
      `Invocation ${args.kind} target must not include stepIndex`,
    );
  }
}

function requireOperation(args: {
  operation: string | undefined;
  expected: string | undefined;
  kind: string;
}): void {
  if (args.operation !== args.expected) {
    const expectation = args.expected
      ? `must be ${args.expected}`
      : "must not be set";
    throw new Error(`Invocation ${args.kind} target.operation ${expectation}`);
  }
}

function parseEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invocation env must be an object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string") {
        throw new Error(`Invocation env.${key} must be a string`);
      }
      return [key, entry];
    }),
  );
}

function requireNonEmptyString(args: {
  value: unknown;
  field: string;
}): string {
  if (typeof args.value !== "string" || args.value.trim() === "") {
    throw new Error(`Invocation ${args.field} must be a non-empty string`);
  }
  return args.value;
}

function isRuntimeWorkKind(value: unknown): value is RuntimeWorkKind {
  return (
    value === "durable-boundary" ||
    value === "batch-source" ||
    value === "batch-step" ||
    value === "batch-sink"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProtocolJsonValue(args: {
  value: unknown;
  seen: WeakSet<object>;
}): JsonValue {
  if (
    args.value === null ||
    typeof args.value === "string" ||
    typeof args.value === "boolean"
  ) {
    return args.value;
  }
  if (typeof args.value === "number") {
    return Number.isFinite(args.value) ? args.value : String(args.value);
  }
  if (typeof args.value === "bigint") return args.value.toString();
  if (typeof args.value === "undefined") return null;
  if (args.value instanceof Error) {
    return {
      name: args.value.name,
      message: args.value.message,
      stack: args.value.stack ?? null,
    };
  }
  if (typeof args.value !== "object") return String(args.value);
  if (args.seen.has(args.value)) return "[Circular]";
  args.seen.add(args.value);
  if (Array.isArray(args.value)) {
    const result = args.value.map((entry) =>
      toProtocolJsonValue({ value: entry, seen: args.seen }),
    );
    args.seen.delete(args.value);
    return result;
  }
  const result = Object.fromEntries(
    Object.entries(args.value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key,
        toProtocolJsonValue({ value: entry, seen: args.seen }),
      ]),
  );
  args.seen.delete(args.value);
  return result;
}
