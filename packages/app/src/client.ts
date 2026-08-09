import type { AppClient, RunHandle, TypedRunSnapshot } from "./contract.js";
import {
  isJsonRpcResponse,
  type JsonRpcRequest,
  type McpToolCallResult,
  POLL_RUN_TOOL,
  toolResultErrorMessage,
  toolResultValue,
} from "./mcp-host.js";
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
const MCP_INITIALIZE_ID = 0;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** Kept so unanswered calls can be re-dispatched on a host-mode flip. */
  message: OutboundCall;
}

/**
 * Guest-side transport. Lives inside the sandboxed iframe and can reach
 * nothing but `postMessage` to its parent — no credentials, no cookies, no
 * host DOM. The host-side broker validates and forwards every call.
 *
 * Dual-runtime: the bridge starts in Catamorphic mode (identical wire
 * behavior to every earlier version) and sends one `ui/initialize`
 * JSON-RPC probe at boot. A Catamorphic host ignores the probe and the
 * bridge never changes. A standard MCP Apps host answers it, flipping the
 * bridge to the MCP dialect: workflow calls become `tools/call`, run
 * polling becomes the {@link POLL_RUN_TOOL} tool, height reports become
 * `ui/notifications/size-changed`. Calls posted before the flip were
 * ignored by the MCP host (wrong shape), so they are re-dispatched —
 * exactly once, in exactly one dialect a host acted on.
 */
class GuestBridge {
  private readonly pending = new Map<string, PendingCall>();
  private context: AppContext | null = null;
  private readonly contextWaiters: ((context: AppContext) => void)[] = [];
  private counter = 0;
  private mode: "catamorphic" | "mcp" = "catamorphic";
  private rpcCounter = MCP_INITIALIZE_ID;
  private readonly rpcPending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  constructor() {
    window.addEventListener("message", (event: MessageEvent) => {
      // srcdoc guests have an opaque origin; the parent is the only window
      // that can reach us, but filter on shape regardless.
      const data: unknown = event.data;
      if (isJsonRpcResponse(data)) {
        this.onRpcResponse(data);
        return;
      }
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

    // MCP Apps host probe. Catamorphic hosts drop unknown message shapes,
    // so this is invisible to them; an answer proves an MCP host.
    this.postRpc({
      jsonrpc: "2.0",
      id: MCP_INITIALIZE_ID,
      method: "ui/initialize",
      params: {},
    });
  }

  private onRpcResponse(response: {
    id: number;
    result?: unknown;
    error?: { message: string };
  }): void {
    if (response.id === MCP_INITIALIZE_ID) {
      if (response.error) return; // Host refused the extension; stay native.
      this.enterMcpMode(response.result);
      return;
    }
    const pending = this.rpcPending.get(response.id);
    if (!pending) return;
    this.rpcPending.delete(response.id);
    if (response.error) {
      pending.reject(new AppCallError("internal", response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private enterMcpMode(initializeResult: unknown): void {
    if (this.mode === "mcp") return;
    this.mode = "mcp";
    // MCP hosts carry no Catamorphic identity; apps get a synthetic
    // context with the host's initialize payload attached for inspection.
    const result =
      typeof initializeResult === "object" && initializeResult !== null
        ? (initializeResult as Record<string, unknown>)
        : {};
    if (!this.context) {
      this.context = {
        tenantId: "mcp-host",
        user: { id: "mcp-user" },
        host: { mcp: true, ...result },
      };
      for (const waiter of this.contextWaiters.splice(0)) {
        waiter(this.context);
      }
    }
    // Calls posted before the flip went out in the Catamorphic dialect,
    // which this host ignored — re-dispatch them as tools/call.
    for (const [callId, entry] of [...this.pending]) {
      this.pending.delete(callId);
      this.dispatchMcp(entry.message).then(entry.resolve, entry.reject);
    }
  }

  private postRpc(message: JsonRpcRequest): void {
    window.parent.postMessage(message, "*");
  }

  private rpcRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.rpcCounter += 1;
    const id = this.rpcCounter;
    return new Promise((resolve, reject) => {
      this.rpcPending.set(id, { resolve, reject });
      this.postRpc({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = (await this.rpcRequest("tools/call", {
      name,
      arguments: args,
    })) as McpToolCallResult;
    if (result.isError) {
      throw new AppCallError("workflow_failed", toolResultErrorMessage(result));
    }
    return toolResultValue(result);
  }

  private dispatchMcp(message: OutboundCall): Promise<unknown> {
    if (message.kind === "poll-run") {
      return this.callTool(POLL_RUN_TOOL, { runId: message.runId });
    }
    // The typed client knows the workflow's kind (invoke = plain, start =
    // durable), the server only knows names — so the mode rides along.
    // Model-initiated calls omit it and the server defaults to invoke.
    return this.callTool(message.workflowName, {
      input: message.input ?? null,
      mode: message.mode,
    });
  }

  getContext(): Promise<AppContext> {
    if (this.context) return Promise.resolve(this.context);
    return new Promise((resolve) => this.contextWaiters.push(resolve));
  }

  send(message: OutboundCall): Promise<unknown> {
    if (this.mode === "mcp") return this.dispatchMcp(message);
    this.counter += 1;
    const callId = `c${this.counter}`;
    const full: GuestToHostMessage = {
      ...message,
      callId,
      catamorphicApp: APP_PROTOCOL_VERSION,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { resolve, reject, message });
      window.parent.postMessage(full, "*");
    });
  }

  reportHeight(height: number): void {
    if (this.mode === "mcp") {
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height },
        },
        "*",
      );
      return;
    }
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
