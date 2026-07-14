import type { BatchStepRateLimit, JsonValue } from "@catamorphic/workflow";

export const RUNTIME_PROTOCOL_VERSION = 2;

export type RuntimeWorkKind =
  | "workflow"
  | "batch-source"
  | "batch-step"
  | "batch-sink";

export interface RuntimeInvocationTarget {
  modulePath: string;
  exportName: string;
  operation?: string;
}

export interface RuntimeInvocationRequest {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  invocationId: string;
  deploymentArtifactId: string;
  kind: RuntimeWorkKind;
  target: RuntimeInvocationTarget;
  input: unknown;
  attempt: number;
  deadlineAt: string;
  replay?: Record<string, unknown>;
  env?: Record<string, string>;
  traceContext?: Record<string, string>;
}

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
  if (!isRuntimeWorkKind(value.kind)) {
    throw new Error("Invocation kind is invalid");
  }
  const target = parseTarget(value.target);
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

  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId,
    deploymentArtifactId,
    kind: value.kind,
    target,
    input: value.input,
    attempt: Number(value.attempt),
    deadlineAt,
    replay,
    env,
    traceContext,
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

function parseTarget(value: unknown): RuntimeInvocationTarget {
  if (!isRecord(value)) {
    throw new Error("Invocation target must be an object");
  }
  const modulePath = requireNonEmptyString({
    value: value.modulePath,
    field: "target.modulePath",
  });
  if (modulePath.includes("\0")) {
    throw new Error("Invocation target.modulePath contains a null byte");
  }
  const exportName = requireNonEmptyString({
    value: value.exportName,
    field: "target.exportName",
  });
  const operation =
    value.operation === undefined
      ? undefined
      : requireNonEmptyString({
          value: value.operation,
          field: "target.operation",
        });
  return { modulePath, exportName, operation };
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
    value === "workflow" ||
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
