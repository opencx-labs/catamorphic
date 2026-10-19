import type { Json, JsonObject } from "@catamorphic/db";

/**
 * One brokered connection action, as a guard sees it (ADR 0162). The
 * credential never appears here: guards judge intent, the broker holds keys.
 */
export interface ConnectionActionContext {
  tenantId: string;
  projectId: string;
  /** The person or project principal whose authority the call uses. */
  actor: string;
  /** An agent session can ask a person; a workflow run cannot. */
  caller: "agent" | "workflow";
  agentSessionId?: string;
  allocationId: string;
  connection: { id: string; kind: string; alias: string };
  action: string;
  input: Json;
}

export type ConnectionGuardVerdict =
  | { verdict: "allow"; reason?: string }
  | { verdict: "deny"; reason: string }
  /** A person must approve before the action runs. */
  | { verdict: "escalate"; reason: string };

/**
 * A host-injected check on brokered connection actions: a SQL policy, a model
 * classifier, a rate limit. Guards are host code (ADR 0183): the framework
 * ships the contract, never a policy. Guards run in order; any deny wins, any
 * escalation requires human approval, a throwing guard denies, and a guard
 * that does not answer in time escalates.
 */
export interface ConnectionActionGuard {
  readonly name: string;
  /** Provider kinds this guard reviews; absent reviews every connection. */
  readonly kinds?: readonly string[];
  review(context: ConnectionActionContext): Promise<ConnectionGuardVerdict>;
}

export interface ConnectionGuardRecord {
  guard: string;
  verdict: ConnectionGuardVerdict["verdict"];
  reason?: string;
}

export type ConnectionReviewOutcome =
  | { verdict: "allow"; records: ConnectionGuardRecord[] }
  | { verdict: "deny"; reason: string; records: ConnectionGuardRecord[] }
  | { verdict: "escalate"; reason: string; records: ConnectionGuardRecord[] };

/** How long one guard may take before its action goes to a person. */
export const DEFAULT_GUARD_TIMEOUT_MS = 30_000;

export async function reviewConnectionAction(args: {
  guards: readonly ConnectionActionGuard[];
  context: ConnectionActionContext;
  timeoutMs?: number;
}): Promise<ConnectionReviewOutcome> {
  const records: ConnectionGuardRecord[] = [];
  const escalations: string[] = [];
  for (const guard of args.guards) {
    if (guard.kinds && !guard.kinds.includes(args.context.connection.kind)) {
      continue;
    }
    let verdict: ConnectionGuardVerdict;
    try {
      verdict = await withTimeout(
        guard.review(args.context),
        args.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS,
      );
    } catch (error) {
      // An unavailable reviewer never waves an action through. A timeout
      // asks a person; a broken guard refuses.
      verdict =
        error instanceof GuardTimeoutError
          ? { verdict: "escalate", reason: `${guard.name} did not answer` }
          : { verdict: "deny", reason: `${guard.name} failed` };
    }
    records.push({
      guard: guard.name,
      verdict: verdict.verdict,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    });
    if (verdict.verdict === "deny") {
      return { verdict: "deny", reason: verdict.reason, records };
    }
    if (verdict.verdict === "escalate") escalations.push(verdict.reason);
  }
  return escalations.length > 0
    ? { verdict: "escalate", reason: escalations.join("; "), records }
    : { verdict: "allow", records };
}

class GuardTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new GuardTimeoutError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One model request through the gateway as a rewrite sees it (ADR 0256).
 * Headers and query are the caller's, read-only: a rewrite governs the
 * body, and refuses a call it will not send by throwing
 * `ConnectionActionRefusedError`.
 */
export interface ModelRequest {
  method: string;
  /** Path below the connection's base URL, e.g. `chat/completions`. */
  path: string;
  query: string;
  headers: Readonly<Record<string, string | undefined>>;
  /** The parsed body; return it, changed or not. */
  body: JsonObject;
  context: {
    tenantId: string;
    projectId: string;
    /** The Environment binding alias the call came through. */
    alias: string;
    /** The connection's provider kind, e.g. `openrouter`. */
    providerKind: string;
    connectionId: string;
    /** Whose key it is: a service connection's or a member's own. */
    principalKind: string;
    sessionId: string | null;
  };
}

/**
 * Host code that rewrites model request bodies before the gateway's policy
 * reads them and the provider receives them (ADR 0256), as guards review
 * actions (ADR 0183). Rewrites run in order; `kinds` limits one to those
 * provider kinds. A rewrite that throws refuses the call, and one slower
 * than the guard timeout refuses it too.
 */
export interface ModelRequestRewrite {
  readonly name: string;
  readonly kinds?: readonly string[];
  rewrite(request: ModelRequest): JsonObject | Promise<JsonObject>;
}
