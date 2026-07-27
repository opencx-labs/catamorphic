import type { RunSnapshot } from "./protocol.js";

/**
 * Contract-shaping types for `@project/contracts`. A project declares:
 *
 * ```typescript
 * export interface ListOrders { input: { status: "open" | "all" }; output: Order[] }
 *
 * export interface AppContract {
 *   listOrders: PlainWorkflow<ListOrders>;
 *   reconcileLedger: DurableWorkflow<ReconcileLedger>;
 * }
 * ```
 *
 * Every call crosses postMessage and JSON over HTTP, so JSON is the narrow
 * waist. `JsonSafe` rejects non-serializable members at compile time with a
 * branded error type naming the offender — a `Date` that types as a `Date`
 * but arrives as a string is exactly the bug this exists to prevent. Authors
 * serialize deliberately rather than relying on silent rewriting.
 */

export type JsonPrimitive = string | number | boolean | null;

export interface JsonSerializationError<Message extends string> {
  __catamorphicAppTypeError: Message;
}

export type JsonSafe<T> = T extends JsonPrimitive
  ? T
  : T extends undefined
    ? JsonSerializationError<"undefined does not survive JSON; use null or omit the field">
    : T extends (...args: never[]) => unknown
      ? JsonSerializationError<"Functions cannot cross the app boundary">
      : T extends Date
        ? JsonSerializationError<"Date does not survive JSON; send an ISO string">
        : T extends Map<unknown, unknown> | Set<unknown>
          ? JsonSerializationError<"Map/Set do not survive JSON; send arrays or objects">
          : T extends readonly (infer E)[]
            ? readonly JsonSafe<E>[]
            : T extends object
              ? { [K in keyof T]: JsonSafe<T[K]> }
              : JsonSerializationError<"This type does not survive JSON">;

export interface WorkflowShape {
  input: unknown;
  output: unknown;
}

declare const plainBrand: unique symbol;
declare const durableBrand: unique symbol;

/**
 * A workflow without persisted continuation: calling it resolves inline with
 * the terminal output.
 */
export interface PlainWorkflow<T extends WorkflowShape> {
  readonly [plainBrand]: "plain";
  readonly input: JsonSafe<T["input"]>;
  readonly output: JsonSafe<T["output"]>;
}

/**
 * A workflow with persisted continuation (`defineWorkflow`, including batch
 * scopes): starting it returns a handle the app polls for completion and
 * progress.
 */
export interface DurableWorkflow<T extends WorkflowShape> {
  readonly [durableBrand]: "durable";
  readonly input: JsonSafe<T["input"]>;
  readonly output: JsonSafe<T["output"]>;
}

export interface RunHandle<Output> {
  readonly runId: string;
  /** Latest snapshot; `output` is typed once status is `completed`. */
  poll(): Promise<TypedRunSnapshot<Output>>;
  /** Polls until a terminal status and resolves with the typed output. */
  result(opts?: { pollIntervalMs?: number }): Promise<Output>;
}

export type TypedRunSnapshot<Output> = Omit<RunSnapshot, "output"> & {
  output: Output | null;
};

/** The callable the client exposes for each contract entry. */
export type ClientMethod<T> =
  T extends PlainWorkflow<infer S>
    ? (input: JsonSafe<S["input"]>) => Promise<JsonSafe<S["output"]>>
    : T extends DurableWorkflow<infer S>
      ? {
          start(
            input: JsonSafe<S["input"]>,
          ): Promise<RunHandle<JsonSafe<S["output"]>>>;
        }
      : never;

export type AppClient<Contract> = {
  readonly [K in keyof Contract]: ClientMethod<Contract[K]>;
};
