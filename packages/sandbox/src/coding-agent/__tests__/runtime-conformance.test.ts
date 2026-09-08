import {
  type AgentRuntimeDescriptor,
  type AgentRuntimeEvent,
  type AgentRuntimeProvider,
  type AgentRuntimeSession,
  AgentRuntimeUnsupportedError,
  type ControlAgentTask,
  type InterruptAgentTurn,
  type RespondToAgentRequest,
  type StartAgentTurn,
} from "@catamorphic/sandbox";
import { defineAgentRuntimeConformance } from "@catamorphic/sandbox/testing";
import { describe } from "vitest";

class FakeAgentRuntime implements AgentRuntimeProvider {
  readonly name = "fake";

  private readonly events: AgentRuntimeEvent[] = [];
  private taskStatus: "running" | "cancelled" = "running";
  private approvalResolved = false;

  private readonly descriptor: AgentRuntimeDescriptor = {
    id: "fake",
    displayName: "Fake Agent Runtime",
    placement: "control_plane",
    resumability: false,
    operations: {
      resumeSession: false,
      retryTurn: true,
      interruptTurn: true,
    },
    capabilities: {
      approvals: true,
      questions: true,
      elicitations: false,
      plans: false,
      tasks: true,
      subagents: false,
      usage: true,
      dynamicTools: false,
    },
    models: [],
    efforts: [],
    builtInTools: [],
    mcpGenerations: [],
    eventFidelity: "normalized",
  };

  async describe(): Promise<AgentRuntimeDescriptor> {
    return this.descriptor;
  }

  async startSession(): Promise<AgentRuntimeSession> {
    this.events.push(
      {
        eventId: "session-started",
        sequence: 1,
        occurredAt: "2026-08-24T00:00:00.000Z",
        sessionId: "fake-session",
        type: "session.started",
        session: { providerSessionId: "fake-provider-session" },
      },
      {
        eventId: "task-running",
        sequence: 2,
        occurredAt: "2026-08-24T00:00:01.000Z",
        sessionId: "fake-session",
        type: "task.updated",
        task: {
          taskId: "fake-task",
          sessionId: "fake-session",
          title: "Conformance task",
          status: "running",
        },
      },
      {
        eventId: "task-running",
        sequence: 2,
        occurredAt: "2026-08-24T00:00:01.000Z",
        sessionId: "fake-session",
        type: "task.updated",
        task: {
          taskId: "fake-task",
          sessionId: "fake-session",
          title: "Conformance task",
          status: "running",
        },
      },
      {
        eventId: "usage-snapshot",
        sequence: 3,
        occurredAt: "2026-08-24T00:00:02.000Z",
        sessionId: "fake-session",
        type: "usage.updated",
        usage: { totalTokens: 1 },
      },
    );
    return {
      sessionId: "fake-session",
      providerSessionId: "fake-provider-session",
      projectId: "fake-project",
      allocationId: "fake-allocation",
      workingDirectory: "/fake-workspace",
    };
  }

  async resumeSession(): Promise<AgentRuntimeSession> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "resumeSession",
    });
  }

  async stopSession(): Promise<void> {}

  async startTurn(
    args: StartAgentTurn,
  ): Promise<{ sessionId: string; turnId: string }> {
    if (
      args.sessionId !== "fake-session" ||
      args.message.role !== "user" ||
      !args.message.content
    ) {
      throw new Error("A turn requires a user message for the active session");
    }
    this.events.push(
      {
        eventId: "turn-started",
        sequence: 4,
        occurredAt: "2026-08-24T00:00:03.000Z",
        sessionId: "fake-session",
        turnId: "fake-turn",
        type: "turn.started",
      },
      {
        eventId: "approval-created",
        sequence: 5,
        occurredAt: "2026-08-24T00:00:04.000Z",
        sessionId: "fake-session",
        turnId: "fake-turn",
        type: "request.created",
        request: {
          requestId: "fake-approval",
          kind: "approval",
          status: "pending",
          sessionId: "fake-session",
          turnId: "fake-turn",
          createdAt: "2026-08-24T00:00:04.000Z",
          origin: { kind: "tool", id: "fake-write" },
          title: "Allow write?",
          approval: { action: "Write a file" },
        },
      },
    );
    return { sessionId: "fake-session", turnId: "fake-turn" };
  }

  async retryTurn(): Promise<{ sessionId: string; turnId: string }> {
    return { sessionId: "fake-session", turnId: "retry-turn" };
  }

  async interruptTurn(args: InterruptAgentTurn): Promise<void> {
    if (args.sessionId !== "fake-session" || args.turnId !== "fake-turn") {
      throw new Error("The requested turn is not active");
    }
    this.events.push({
      eventId: "turn-interrupted",
      sequence: 6,
      occurredAt: "2026-08-24T00:00:05.000Z",
      sessionId: "fake-session",
      turnId: "fake-turn",
      type: "turn.interrupted",
      reason: "Requested by the host",
    });
  }

  async respond(args: RespondToAgentRequest): Promise<void> {
    if (
      args.sessionId !== "fake-session" ||
      args.requestId !== "fake-approval" ||
      args.response.kind !== "approval" ||
      args.response.decision !== "approved" ||
      this.approvalResolved
    ) {
      throw new Error("The pending approval was not resolved correctly");
    }
    this.approvalResolved = true;
    this.events.push({
      eventId: "approval-resolved",
      sequence: 6,
      occurredAt: "2026-08-24T00:00:05.000Z",
      sessionId: "fake-session",
      turnId: "fake-turn",
      type: "request.resolved",
      requestId: "fake-approval",
      resolution: { kind: "approval", decision: "approved" },
    });
  }

  async *subscribe(args: {
    sessionId: string;
    after?: { sequence: number };
  }): AsyncIterable<AgentRuntimeEvent> {
    for (const event of this.events) {
      if (
        event.sessionId === args.sessionId &&
        event.sequence > (args.after?.sequence ?? 0)
      ) {
        yield event;
      }
    }
  }

  async listTasks(): Promise<
    readonly [
      {
        taskId: string;
        sessionId: string;
        title: string;
        status: "running" | "cancelled";
      },
    ]
  > {
    return [
      {
        taskId: "fake-task",
        sessionId: "fake-session",
        title: "Conformance task",
        status: this.taskStatus,
      },
    ];
  }

  async controlTask(args: ControlAgentTask): Promise<void> {
    if (
      args.sessionId !== "fake-session" ||
      args.taskId !== "fake-task" ||
      args.action !== "cancel"
    ) {
      throw new Error("The task control command is invalid");
    }
    this.taskStatus = "cancelled";
  }
}

describe("FakeAgentRuntime", () => {
  defineAgentRuntimeConformance({
    create: () => new FakeAgentRuntime(),
    expected: {
      approvals: true,
      questions: true,
      tasks: true,
      operations: {
        resumeSession: false,
        retryTurn: true,
        interruptTurn: true,
      },
    },
    driver: {
      startSession: ({ provider }) =>
        provider.startSession({
          sessionId: "fake-session",
          projectId: "fake-project",
          allocationId: "fake-allocation",
          workingDirectory: "/fake-workspace",
        }),
      startTurn: ({ provider, session }) =>
        provider.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Run the conformance turn." },
        }),
      responseFor: () => ({ kind: "approval", decision: "approved" }),
      controlTask: ({ provider, session, task }) =>
        provider.controlTask({
          sessionId: session.sessionId,
          taskId: task.taskId,
          action: "cancel",
        }),
      assertTaskControl: ({ before, after }) => {
        const controlled = after.find((task) => task.taskId === before.taskId);
        if (controlled?.status !== "cancelled") {
          throw new Error("The task control did not cancel the selected task");
        }
      },
    },
  });
});
