import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type { AgentRuntimeEvent } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  AgentRuntimeEventSequenceConflictError,
  AgentRuntimeEventsService,
} from "../services/agent-runtime-events-service.js";
import { AccessDeniedError } from "../services/artifact-scope.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_agent_runtime_events_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 4 });

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "runtime-events-test",
};
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();

function event(args: { eventId: string; sequence: number }): AgentRuntimeEvent {
  return {
    eventId: args.eventId,
    sequence: args.sequence,
    occurredAt: "2026-08-24T00:00:00.000Z",
    sessionId,
    type: "turn.started",
  };
}

describeIf("agent runtime event persistence", () => {
  let events: AgentRuntimeEventsService;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: identity.tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: identity.tenantId, name: "P" })
      .execute();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: "test",
      })
      .execute();
    events = new AgentRuntimeEventsService(db);
  });

  afterAll(async () => {
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
  });

  async function createSession(
    input: { agentId?: string | null; externalUserId?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({
        id,
        project_id: projectId,
        external_user_id: input.externalUserId ?? identity.externalUserId,
        provider: "test",
        agent_id: input.agentId ?? null,
      })
      .execute();
    return id;
  }

  function eventFor(args: {
    eventId: string;
    sequence: number;
    sessionId: string;
    providerPayloadRef?: string;
  }): AgentRuntimeEvent {
    return {
      ...event({ eventId: args.eventId, sequence: args.sequence }),
      sessionId: args.sessionId,
      ...(args.providerPayloadRef === undefined
        ? { providerPayloadRef: undefined }
        : { providerPayloadRef: args.providerPayloadRef }),
    };
  }

  it("deduplicates a replay of the same provider event", async () => {
    const first = event({ eventId: crypto.randomUUID(), sequence: 1 });

    await events.append({ identity, event: first });
    await events.append({ identity, event: first });

    expect(
      await events.list({ identity, sessionId, afterSequence: 0 }),
    ).toEqual([first]);
  });

  it("rejects a new event that leaves a sequence gap", async () => {
    await expect(
      events.append({
        identity,
        event: event({ eventId: crypto.randomUUID(), sequence: 3 }),
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeEventSequenceConflictError);
  });

  it("deduplicates concurrent replays of the next provider event", async () => {
    const concurrentSession = await createSession();
    const next = eventFor({
      eventId: crypto.randomUUID(),
      sequence: 1,
      sessionId: concurrentSession,
    });

    const outcomes = await Promise.all([
      events.append({ identity, event: next }),
      events.append({ identity, event: next }),
    ]);

    expect(outcomes.map((outcome) => outcome.inserted).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await events.list({
        identity,
        sessionId: concurrentSession,
        afterSequence: 0,
      }),
    ).toEqual([next]);
  });

  it("rejects conflicting provider event id and sequence reuse", async () => {
    const conflictSession = await createSession();
    const first = eventFor({
      eventId: crypto.randomUUID(),
      sequence: 1,
      sessionId: conflictSession,
    });
    await events.append({ identity, event: first });

    await expect(
      events.append({
        identity,
        event: eventFor({
          eventId: crypto.randomUUID(),
          sequence: 1,
          sessionId: conflictSession,
        }),
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeEventSequenceConflictError);
    await expect(
      events.append({
        identity,
        event: eventFor({
          eventId: first.eventId,
          sequence: 2,
          sessionId: conflictSession,
        }),
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeEventSequenceConflictError);
  });

  it("canonicalizes omitted optional event fields before replay comparison", async () => {
    const canonicalSession = await createSession();
    const first = eventFor({
      eventId: crypto.randomUUID(),
      sequence: 1,
      sessionId: canonicalSession,
    });
    const replay = {
      ...first,
      providerPayloadRef: undefined,
    } satisfies AgentRuntimeEvent;

    expect(await events.append({ identity, event: first })).toEqual({
      inserted: true,
    });
    expect(await events.append({ identity, event: replay })).toEqual({
      inserted: false,
    });
  });

  it("requires a scoped caller to own the session and cover its project agent", async () => {
    const agentId = `project:${projectId}:csm`;
    const owner = "alice";
    const scopedSession = await createSession({
      agentId,
      externalUserId: owner,
    });
    const allowed = {
      tenantId: identity.tenantId,
      externalUserId: owner,
      scope: [{ kind: "agent" as const, projectId, name: "csm" }],
    };
    const denied = [
      { ...allowed, externalUserId: "bob" },
      {
        ...allowed,
        scope: [{ kind: "agent" as const, projectId, name: "sales" }],
      },
      {
        ...allowed,
        scope: [{ kind: "document" as const, projectId, path: "notes.md" }],
      },
      {
        ...allowed,
        scope: [{ kind: "workflow" as const, projectId, name: "notify" }],
      },
    ];

    await events.append({
      identity: allowed,
      event: eventFor({
        eventId: crypto.randomUUID(),
        sequence: 1,
        sessionId: scopedSession,
      }),
    });
    for (const caller of denied) {
      await expect(
        events.list({
          identity: caller,
          sessionId: scopedSession,
          afterSequence: 0,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
  });

  it("polls the durable cursor for appends from another service instance", async () => {
    const sharedSession = await createSession();
    const reader = new AgentRuntimeEventsService(db, { pollIntervalMs: 10 });
    const writer = new AgentRuntimeEventsService(db, { pollIntervalMs: 10 });
    const subscription = reader
      .subscribe({ identity, sessionId: sharedSession })
      [Symbol.asyncIterator]();
    const next = subscription.next();
    const published = eventFor({
      eventId: crypto.randomUUID(),
      sequence: 1,
      sessionId: sharedSession,
    });

    await writer.append({ identity, event: published });
    const delivered = await Promise.race([
      next,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("subscription did not poll")), 500),
      ),
    ]);

    expect(delivered.value).toEqual(published);
    await subscription.return?.();
  });
});
