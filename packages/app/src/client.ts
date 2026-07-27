import type { AppClient, RunHandle, TypedRunSnapshot } from "./contract.js";
import {
  APP_PROTOCOL_VERSION,
  AppCallError,
  type AppContext,
  type GuestToHostMessage,
  isHostMessage,
  type RunSnapshot,
} from "./protocol.js";

/** Call-shaped guest messages, minus the fields the bridge fills in. */
type OutboundCall =
  | {
      kind: "call";
      workflowName: string;
      mode: "invoke" | "start";
      input: unknown;
    }
  | { kind: "poll-run"; runId: string };

const DEFAULT_POLL_INTERVAL_MS = 750;
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Guest-side transport. Lives inside the sandboxed iframe and can reach
 * nothing but `postMessage` to its parent — no credentials, no cookies, no
 * host DOM. The host-side broker validates and forwards every call.
 */
class GuestBridge {
  private readonly pending = new Map<string, PendingCall>();
  private context: AppContext | null = null;
  private readonly contextWaiters: ((context: AppContext) => void)[] = [];
  private counter = 0;

  constructor() {
    window.addEventListener("message", (event: MessageEvent) => {
      // srcdoc guests have an opaque origin; the parent is the only window
      // that can reach us, but filter on shape regardless.
      const data: unknown = event.data;
      if (!isHostMessage(data)) return;
      if (data.kind === "context") {
        this.context = data.context;
        for (const waiter of this.contextWaiters.splice(0)) {
          waiter(data.context);
        }
        return;
      }
      const pending = this.pending.get(data.callId);
      if (!pending) return;
      this.pending.delete(data.callId);
      if (data.ok) pending.resolve(data.value);
      else
        pending.reject(new AppCallError(data.error.code, data.error.message));
    });
  }

  getContext(): Promise<AppContext> {
    if (this.context) return Promise.resolve(this.context);
    return new Promise((resolve) => this.contextWaiters.push(resolve));
  }

  send(message: OutboundCall): Promise<unknown> {
    this.counter += 1;
    const callId = `c${this.counter}`;
    const full: GuestToHostMessage = {
      ...message,
      callId,
      catamorphicApp: APP_PROTOCOL_VERSION,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { resolve, reject });
      window.parent.postMessage(full, "*");
    });
  }

  reportHeight(height: number): void {
    window.parent.postMessage(
      { catamorphicApp: APP_PROTOCOL_VERSION, kind: "resize", height },
      "*",
    );
  }
}

let bridge: GuestBridge | undefined;

function getBridge(): GuestBridge {
  bridge ??= new GuestBridge();
  return bridge;
}

/**
 * Typed client over the project's app contract:
 *
 * ```typescript
 * import type { AppContract } from "@project/contracts";
 * const workflows = createClient<AppContract>();
 * const orders = await workflows.listOrders({ status: "open" });
 * const run = await workflows.reconcileLedger.start({ month: "2026-07" });
 * ```
 *
 * Plain workflows resolve inline; durable ones return a {@link RunHandle}.
 * The proxy sends whatever name is accessed — the server enforces the frozen
 * set, so an out-of-contract name fails with `denied` at runtime and a type
 * error at compile time.
 */
export function createClient<Contract>(): AppClient<Contract> {
  const transport = getBridge();
  return new Proxy({} as AppClient<Contract>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      const invoke = (input: unknown) =>
        transport.send({
          kind: "call",
          workflowName: property,
          mode: "invoke",
          input,
        });
      const callable = Object.assign(invoke, {
        start: async (input: unknown) => {
          const value = await transport.send({
            kind: "call",
            workflowName: property,
            mode: "start",
            input,
          });
          const { runId } = value as { runId: string };
          return makeRunHandle(transport, runId);
        },
      });
      return callable;
    },
  });
}

function makeRunHandle(
  transport: GuestBridge,
  runId: string,
): RunHandle<unknown> {
  const poll = async (): Promise<TypedRunSnapshot<unknown>> => {
    const snapshot = (await transport.send({
      kind: "poll-run",
      runId,
    })) as RunSnapshot;
    return { ...snapshot, output: snapshot.output ?? null };
  };
  return {
    runId,
    poll,
    result: async (opts) => {
      const interval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      for (;;) {
        const snapshot = await poll();
        if (snapshot.status === "completed") return snapshot.output;
        if (TERMINAL_STATUSES.has(snapshot.status)) {
          throw new AppCallError(
            "workflow_failed",
            snapshot.error ?? `Run ${runId} ${snapshot.status}`,
          );
        }
        await sleep(interval);
      }
    },
  };
}

/** Mount-time snapshot from the host: tenant, user, and host extras. */
export function getContext(): Promise<AppContext> {
  return getBridge().getContext();
}

/** Reports content height so the host can size the iframe. */
export function reportHeight(height: number): void {
  getBridge().reportHeight(height);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
