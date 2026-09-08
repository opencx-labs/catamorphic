import {
  type AgentRuntimeEvent,
  type AgentRuntimeProvider,
  type AgentRuntimeRequest,
  type AgentRuntimeRequestResponse,
  type AgentRuntimeSession,
  AgentRuntimeUnsupportedError,
  type AgentTask,
  type AgentTurnHandle,
} from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";

export interface AgentRuntimeConformanceFactory {
  create(): AgentRuntimeProvider;
  expected: {
    approvals: boolean;
    questions: boolean;
    tasks: boolean;
    operations: {
      resumeSession: boolean;
      retryTurn: boolean;
      interruptTurn: boolean;
    };
  };
  driver: AgentRuntimeConformanceDriver;
}

/**
 * Provider-specific deterministic setup for the shared behavioral suite.
 * This keeps the suite focused on invariants rather than invented fixture ids.
 */
export interface AgentRuntimeConformanceDriver {
  startSession(args: {
    provider: AgentRuntimeProvider;
  }): Promise<AgentRuntimeSession>;
  startTurn(args: {
    provider: AgentRuntimeProvider;
    session: AgentRuntimeSession;
  }): Promise<AgentTurnHandle>;
  responseFor(args: {
    request: AgentRuntimeRequest;
  }): AgentRuntimeRequestResponse;
  controlTask(args: {
    provider: AgentRuntimeProvider;
    session: AgentRuntimeSession;
    task: AgentTask;
  }): Promise<void>;
  assertTaskControl(args: {
    before: AgentTask;
    after: readonly AgentTask[];
  }): void | Promise<void>;
  resumeSession?(args: {
    provider: AgentRuntimeProvider;
    session: AgentRuntimeSession;
  }): Promise<AgentRuntimeSession>;
  retryTurn?(args: {
    provider: AgentRuntimeProvider;
    session: AgentRuntimeSession;
    turn: AgentTurnHandle;
  }): Promise<AgentTurnHandle>;
  interruptTurn?(args: {
    provider: AgentRuntimeProvider;
    session: AgentRuntimeSession;
    turn: AgentTurnHandle;
  }): Promise<void>;
}

/**
 * Registers the shared behavioral contract every runtime adapter must pass.
 * Provider fixtures supply deterministic setup and native response semantics.
 */
export function defineAgentRuntimeConformance(
  factory: AgentRuntimeConformanceFactory,
): void {
  describe("AgentRuntimeProvider conformance", () => {
    it("reports capabilities and command support truthfully", async () => {
      const descriptor = await factory.create().describe({});

      expect(descriptor.capabilities.approvals).toBe(
        factory.expected.approvals,
      );
      expect(descriptor.capabilities.questions).toBe(
        factory.expected.questions,
      );
      expect(descriptor.capabilities.tasks).toBe(factory.expected.tasks);
      expect(descriptor.operations).toEqual(factory.expected.operations);
      expect(descriptor.resumability).toBe(
        factory.expected.operations.resumeSession,
      );
    });

    it("orders at-least-once delivery and reduces duplicate event ids once", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });
      const delivered = await collectEvents({ provider, session });
      const reduced = reduceAgentRuntimeEvents(delivered);

      expect(delivered.length).toBeGreaterThan(reduced.length);
      expect(reduced.map((event) => event.eventId)).toHaveLength(
        new Set(reduced.map((event) => event.eventId)).size,
      );
      expect(reduced.map((event) => event.sequence)).toEqual(
        [...reduced]
          .map((event) => event.sequence)
          .sort((left, right) => left - right),
      );
    });

    it("resumes from an exclusive event cursor", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });
      const reduced = reduceAgentRuntimeEvents(
        await collectEvents({ provider, session }),
      );
      const pair = consecutiveEvents(reduced);

      if (!pair) {
        throw new Error("Conformance provider did not emit consecutive events");
      }
      const replay = await collectEvents({
        provider,
        session,
        after: { sequence: pair.before.sequence },
      });

      expect(replay[0]?.sequence).toBe(pair.after.sequence);
    });

    it("rejects unsupported resume and supports it only when declared", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });

      if (factory.expected.operations.resumeSession) {
        const resumed = await resumeSession({ provider, session, factory });
        expect(resumed.sessionId).toBe(session.sessionId);
        return;
      }

      await expect(
        resumeSession({ provider, session, factory }),
      ).rejects.toBeInstanceOf(AgentRuntimeUnsupportedError);
    });

    it("starts a turn before emitting its request and resolves that request", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });
      const turn = await factory.driver.startTurn({ provider, session });
      const events = reduceAgentRuntimeEvents(
        await collectEvents({ provider, session }),
      );
      const turnStarted = events.findIndex(
        (event) =>
          event.type === "turn.started" && event.turnId === turn.turnId,
      );
      const requestIndex = events.findIndex(
        (event) =>
          event.type === "request.created" && event.turnId === turn.turnId,
      );

      expect(turnStarted).toBeGreaterThanOrEqual(0);
      expect(requestIndex).toBeGreaterThan(turnStarted);
      const requestEvent = events[requestIndex];
      if (requestEvent?.type !== "request.created") {
        throw new Error(
          "Conformance provider did not emit a request for its turn",
        );
      }
      await provider.respond({
        sessionId: session.sessionId,
        requestId: requestEvent.request.requestId,
        response: factory.driver.responseFor({ request: requestEvent.request }),
      });

      const resolutions = await collectEvents({
        provider,
        session,
        after: { sequence: requestEvent.sequence },
      });
      expect(resolutions).toContainEqual(
        expect.objectContaining({
          type: "request.resolved",
          requestId: requestEvent.request.requestId,
        }),
      );
    });

    it("retries turns only when declared", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });
      const turn = await factory.driver.startTurn({ provider, session });

      if (factory.expected.operations.retryTurn) {
        const retry = await retryTurn({ provider, session, turn, factory });
        expect(retry.sessionId).toBe(session.sessionId);
        expect(retry.turnId).not.toBe("");
        return;
      }

      await expect(
        retryTurn({ provider, session, turn, factory }),
      ).rejects.toBeInstanceOf(AgentRuntimeUnsupportedError);
    });

    it("interrupts turns only when declared", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });
      const turn = await factory.driver.startTurn({ provider, session });

      if (factory.expected.operations.interruptTurn) {
        await interruptTurn({ provider, session, turn, factory });
        const events = await collectEvents({
          provider,
          session,
          after: { sequence: 0 },
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "turn.interrupted",
            turnId: turn.turnId,
          }),
        );
        return;
      }

      await expect(
        interruptTurn({ provider, session, turn, factory }),
      ).rejects.toBeInstanceOf(AgentRuntimeUnsupportedError);
    });

    it("controls provider tasks only when tasks are declared", async () => {
      const provider = factory.create();
      const session = await factory.driver.startSession({ provider });

      if (!factory.expected.tasks) {
        await expect(
          provider.listTasks({ sessionId: session.sessionId }),
        ).rejects.toBeInstanceOf(AgentRuntimeUnsupportedError);
        return;
      }

      const [task] = await provider.listTasks({ sessionId: session.sessionId });
      if (!task) throw new Error("Conformance provider did not expose a task");
      await factory.driver.controlTask({ provider, session, task });
      const after = await provider.listTasks({ sessionId: session.sessionId });
      await factory.driver.assertTaskControl({ before: task, after });
    });
  });
}

export function reduceAgentRuntimeEvents(
  events: readonly AgentRuntimeEvent[],
): readonly AgentRuntimeEvent[] {
  const eventIds = new Set<string>();
  const reduced: AgentRuntimeEvent[] = [];

  for (const event of events) {
    if (eventIds.has(event.eventId)) continue;
    eventIds.add(event.eventId);
    reduced.push(event);
  }

  return reduced;
}

async function collectEvents(args: {
  provider: AgentRuntimeProvider;
  session: AgentRuntimeSession;
  after?: { sequence: number };
}): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of args.provider.subscribe({
    sessionId: args.session.sessionId,
    after: args.after,
  })) {
    events.push(event);
  }
  return events;
}

function consecutiveEvents(
  events: readonly AgentRuntimeEvent[],
): { before: AgentRuntimeEvent; after: AgentRuntimeEvent } | undefined {
  for (const [index, event] of events.entries()) {
    const next = events[index + 1];
    if (next && next.sequence > event.sequence) {
      return { before: event, after: next };
    }
  }
  return undefined;
}

function resumeSession(args: {
  provider: AgentRuntimeProvider;
  session: AgentRuntimeSession;
  factory: AgentRuntimeConformanceFactory;
}): Promise<AgentRuntimeSession> {
  if (args.factory.driver.resumeSession) {
    return args.factory.driver.resumeSession({
      provider: args.provider,
      session: args.session,
    });
  }
  if (!args.session.providerSessionId) {
    throw new Error(
      "A resumable conformance session needs a provider session id",
    );
  }
  return args.provider.resumeSession({
    sessionId: args.session.sessionId,
    providerSessionId: args.session.providerSessionId,
    projectId: args.session.projectId,
    allocationId: args.session.allocationId,
    workingDirectory: args.session.workingDirectory,
    after: { sequence: 0 },
  });
}

function retryTurn(args: {
  provider: AgentRuntimeProvider;
  session: AgentRuntimeSession;
  turn: AgentTurnHandle;
  factory: AgentRuntimeConformanceFactory;
}): Promise<AgentTurnHandle> {
  if (args.factory.driver.retryTurn) {
    return args.factory.driver.retryTurn({
      provider: args.provider,
      session: args.session,
      turn: args.turn,
    });
  }
  return args.provider.retryTurn({
    sessionId: args.session.sessionId,
    turnId: args.turn.turnId,
  });
}

function interruptTurn(args: {
  provider: AgentRuntimeProvider;
  session: AgentRuntimeSession;
  turn: AgentTurnHandle;
  factory: AgentRuntimeConformanceFactory;
}): Promise<void> {
  if (args.factory.driver.interruptTurn) {
    return args.factory.driver.interruptTurn({
      provider: args.provider,
      session: args.session,
      turn: args.turn,
    });
  }
  return args.provider.interruptTurn({
    sessionId: args.session.sessionId,
    turnId: args.turn.turnId,
  });
}
