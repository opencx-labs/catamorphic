import { randomUUID } from "node:crypto";
import type {
  ToolPermissionDecision,
  ToolPermissionHandler,
  ToolPermissionRequest,
} from "@catamorphic/sandbox";

/**
 * The host-side answer to a tool-permission "ask" (ADR 0054) for hosts
 * without a desktop bridge: an embedding backend whose users sit in a
 * browser. A harness's `onToolPermission` calls {@link ask}; the request
 * parks here as a pending record the host UI lists (per session) and
 * answers over HTTP; the harness's promise resolves with the decision.
 * Unanswered asks deny on timeout — a tool call must never hang forever
 * on a UI that isn't there.
 *
 * "Always allow" is the host's to persist (it knows where the connection
 * policy lives); the broker only relays the decision.
 */

export interface PendingToolPermission {
  id: string;
  /** Host chat session the ask belongs to (from the request). */
  sessionId?: string;
  /** Who is asking (agent name), for the card. */
  agentLabel?: string;
  request: ToolPermissionRequest;
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ToolPermissionBroker {
  private readonly pending = new Map<
    string,
    PendingToolPermission & {
      resolve: (decision: ToolPermissionDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** A handler to hand a harness (`onToolPermission`), labeled by agent. */
  handlerFor(agentLabel?: string): ToolPermissionHandler {
    return (request) => this.ask(request, agentLabel);
  }

  ask(
    request: ToolPermissionRequest,
    agentLabel?: string,
  ): Promise<ToolPermissionDecision> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const now = Date.now();
      const timer = setTimeout(() => {
        this.settle(id, { decision: "deny" });
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        id,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(agentLabel ? { agentLabel } : {}),
        request,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.timeoutMs).toISOString(),
        resolve,
        timer,
      });
      this.emit();
    });
  }

  /** Pending asks, optionally for one session, oldest first. */
  list(sessionId?: string): PendingToolPermission[] {
    return [...this.pending.values()]
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .map(({ resolve: _r, timer: _t, ...entry }) => entry);
  }

  get(id: string): PendingToolPermission | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    const { resolve: _r, timer: _t, ...rest } = entry;
    return rest;
  }

  /** Answer one ask. False when it's unknown (answered, expired). */
  answer(id: string, decision: ToolPermissionDecision): boolean {
    return this.settle(id, decision);
  }

  /** Subscribe to pending-set changes (for push transports). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private settle(id: string, decision: ToolPermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    this.emit();
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
