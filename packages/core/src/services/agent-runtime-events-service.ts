import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { AgentEventCursor, AgentRuntimeEvent } from "@catamorphic/sandbox";
import type { Kysely, Transaction } from "kysely";
import type { Identity } from "../identity.js";
import {
  canonicalRuntimeJson,
  sameCanonicalRuntimeJson,
} from "./agent-runtime-json.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";

const tracer = getTracer("@catamorphic/core");

export class AgentRuntimeSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent runtime session '${sessionId}' not found`);
    this.name = "AgentRuntimeSessionNotFoundError";
  }
}

export class AgentRuntimeEventSequenceConflictError extends Error {
  constructor(args: { sessionId: string; sequence: number }) {
    super(
      `Agent runtime session '${args.sessionId}' cannot append sequence ${args.sequence}`,
    );
    this.name = "AgentRuntimeEventSequenceConflictError";
  }
}

export interface AgentRuntimeEventsOptions {
  /** Durable cursor polling period. Local listeners wake sooner. */
  pollIntervalMs?: number;
}

type EventListener = (event: AgentRuntimeEvent) => void;

/** Durable event log for a provider-owned, long-lived agent session. */
export class AgentRuntimeEventsService {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: Kysely<DB>,
    options: AgentRuntimeEventsOptions = {},
  ) {
    this.pollIntervalMs = Math.min(
      10_000,
      Math.max(10, options.pollIntervalMs ?? 1_000),
    );
  }

  async append(args: {
    identity: Identity;
    event: AgentRuntimeEvent;
  }): Promise<{ inserted: boolean }> {
    const { event } = args;
    return withSpan(
      {
        tracer,
        name: "agent.runtime.event.append",
        attributes: {
          "catamorphic.session.id": event.sessionId,
          ...(event.turnId
            ? { "catamorphic.agent.turn_id": event.turnId }
            : {}),
        },
      },
      async () => {
        const inserted = await this.db.transaction().execute(async (trx) => {
          await requireRuntimeSession({
            db: trx,
            identity: args.identity,
            sessionId: event.sessionId,
            lock: true,
          });
          return appendEvent({ trx, event });
        });
        if (inserted) this.publish(event);
        return { inserted };
      },
    );
  }

  async list(args: {
    identity: Identity;
    sessionId: string;
    afterSequence: number;
  }): Promise<AgentRuntimeEvent[]> {
    await requireRuntimeSession({
      db: this.db,
      identity: args.identity,
      sessionId: args.sessionId,
      lock: false,
    });
    const events = await this.db
      .selectFrom("agent_runtime_events")
      .select("payload")
      .where("session_id", "=", args.sessionId)
      .where("sequence", ">", String(args.afterSequence))
      .orderBy("sequence", "asc")
      .execute();
    return events.map((event) => eventFromPayload(event.payload));
  }

  async *subscribe(args: {
    identity: Identity;
    sessionId: string;
    after?: AgentEventCursor;
  }): AsyncIterable<AgentRuntimeEvent> {
    const queue: AgentRuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    const listener: EventListener = (event) => {
      queue.push(event);
      wake?.();
    };
    this.addListener(args.sessionId, listener);
    let sequence = args.after?.sequence ?? 0;
    try {
      for (const event of await this.list({
        identity: args.identity,
        sessionId: args.sessionId,
        afterSequence: sequence,
      })) {
        sequence = event.sequence;
        yield event;
      }
      while (true) {
        const next = queue.shift();
        if (next) {
          if (next.sequence > sequence) {
            sequence = next.sequence;
            yield next;
          }
          continue;
        }
        for (const event of await this.list({
          identity: args.identity,
          sessionId: args.sessionId,
          afterSequence: sequence,
        })) {
          sequence = event.sequence;
          yield event;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, this.pollIntervalMs);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      }
    } finally {
      wake?.();
      wake = undefined;
      this.removeListener(args.sessionId, listener);
    }
  }

  private publish(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
  }

  private addListener(sessionId: string, listener: EventListener): void {
    const listeners = this.listeners.get(sessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
  }

  private removeListener(sessionId: string, listener: EventListener): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(sessionId);
  }
}

async function appendEvent(args: {
  trx: Transaction<DB>;
  event: AgentRuntimeEvent;
}): Promise<boolean> {
  const payload = canonicalRuntimeJson(args.event);
  const collisions = await args.trx
    .selectFrom("agent_runtime_events")
    .select(["event_id", "payload", "sequence"])
    .where("session_id", "=", args.event.sessionId)
    .where((eb) =>
      eb.or([
        eb("sequence", "=", String(args.event.sequence)),
        eb("event_id", "=", args.event.eventId),
      ]),
    )
    .forUpdate()
    .execute();
  if (collisions.length > 0) {
    const duplicate =
      collisions.length === 1 &&
      collisions[0]?.event_id === args.event.eventId &&
      Number(collisions[0]?.sequence) === args.event.sequence &&
      sameCanonicalRuntimeJson(collisions[0]?.payload, payload);
    if (duplicate) return false;
    throw new AgentRuntimeEventSequenceConflictError({
      sessionId: args.event.sessionId,
      sequence: args.event.sequence,
    });
  }

  const maximum = await args.trx
    .selectFrom("agent_runtime_events")
    .select(({ fn }) => fn.max("sequence").as("sequence"))
    .where("session_id", "=", args.event.sessionId)
    .executeTakeFirst();
  const expected = Number(maximum?.sequence ?? "0") + 1;
  if (
    !Number.isSafeInteger(args.event.sequence) ||
    args.event.sequence !== expected
  ) {
    throw new AgentRuntimeEventSequenceConflictError({
      sessionId: args.event.sessionId,
      sequence: args.event.sequence,
    });
  }

  await args.trx
    .insertInto("agent_runtime_events")
    .values({
      session_id: args.event.sessionId,
      sequence: args.event.sequence,
      event_id: args.event.eventId,
      turn_id: args.event.turnId ?? null,
      provider_payload_ref: args.event.providerPayloadRef ?? null,
      event_type: args.event.type,
      occurred_at: args.event.occurredAt,
      payload,
    })
    .execute();
  return true;
}

export async function requireRuntimeSession(args: {
  db: Kysely<DB> | Transaction<DB>;
  identity: Identity;
  sessionId: string;
  lock: boolean;
}): Promise<{ projectId: string }> {
  let sessionQuery = args.db
    .selectFrom("agent_sessions")
    .select(["agent_id", "external_user_id", "project_id"])
    .where("id", "=", args.sessionId);
  if (args.lock) sessionQuery = sessionQuery.forUpdate();
  const session = await sessionQuery.executeTakeFirst();
  if (!session) throw new AgentRuntimeSessionNotFoundError(args.sessionId);
  const project = await args.db
    .selectFrom("projects")
    .select("id")
    .where("id", "=", session.project_id)
    .where("tenant_id", "=", args.identity.tenantId)
    .executeTakeFirst();
  if (!project) {
    throw new AgentRuntimeSessionNotFoundError(args.sessionId);
  }
  assertAgentSessionAccess({
    identity: args.identity,
    projectId: session.project_id,
    externalUserId: session.external_user_id,
    agentId: session.agent_id,
  });
  return { projectId: session.project_id };
}

function eventFromPayload(payload: unknown): AgentRuntimeEvent {
  return JSON.parse(JSON.stringify(payload));
}
