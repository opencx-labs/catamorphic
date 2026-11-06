import { createHash } from "node:crypto";
import {
  type Json,
  jsonbText,
  storableText,
  storedJson,
} from "@catamorphic/db";
import type { Identity } from "../identity.js";

export interface SignalRunInput {
  identity: Identity;
  projectId: string;
  workflowName: string;
  correlationKey: string;
  /** The enrollment's generation; a callback must never follow a restart. */
  runId: string;
  signal: string;
  idempotencyKey: string;
  value: Json;
}

export type RunSignalReceipt = {
  id: string;
  runId: string;
} & (
  | { status: "buffered" | "discarded"; pauseId: null }
  | { status: "resumed"; pauseId: string }
);

export const RUN_SIGNAL_MAX_BYTES = 64 * 1024;
export const RUN_SIGNAL_MAX_PENDING = 256;
export const RUN_SIGNAL_MAX_RECEIPTS = 1024;

export class RunSignalNotFoundError extends Error {
  constructor(
    readonly workflowName: string,
    readonly correlationKey: string,
    readonly signal: string,
  ) {
    super(
      `Workflow '${workflowName}' has no matching run generation for signal '${signal}' and correlation key '${correlationKey}'`,
    );
    this.name = "RunSignalNotFoundError";
  }
}

export class RunSignalInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunSignalInvalidError";
  }
}

export class RunSignalLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunSignalLimitError";
  }
}

/** Hash the stored JSON value, independent of object key insertion order. */
export function signalPayload(args: SignalRunInput) {
  for (const [label, value] of [
    ["signal", args.signal],
    ["idempotencyKey", args.idempotencyKey],
  ]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 255)
      throw new RunSignalInvalidError(
        `${label} must contain 1 to 255 characters`,
      );
  }
  let encoded: string;
  try {
    encoded = canonicalJson(storedJson(args.value));
  } catch {
    throw new RunSignalInvalidError("Signal value must be JSON-compatible");
  }
  if (Buffer.byteLength(encoded, "utf8") > RUN_SIGNAL_MAX_BYTES)
    throw new RunSignalLimitError("Signal value exceeds 64 KiB");
  return {
    name: storableText(args.signal),
    payloadHash: createHash("sha256").update(encoded).digest("hex"),
  };
}

function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
      .map(([key, item]) => `${jsonbText(key)}:${canonicalJson(item ?? null)}`)
      .join(",")}}`;
  }
  return jsonbText(value);
}
