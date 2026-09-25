import type { Json } from "@catamorphic/db";

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
 * classifier, a rate limit. Guards run in order; any deny wins, any escalation
 * requires human approval, and an error or timeout fails closed.
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

const DEFAULT_GUARD_TIMEOUT_MS = 30_000;

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
