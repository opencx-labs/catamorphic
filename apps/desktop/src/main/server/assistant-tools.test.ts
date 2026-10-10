import type { AgentSession, AgentSessionDetail } from "@catamorphic/core";
import { describe, expect, it } from "vitest";
import { type AssistantAccess, assistantTools } from "./assistant-tools.js";

const ASSISTANT = "assistant-chat";

function chat(id: string, fields: Partial<AgentSession> = {}): AgentSession {
  // Only the fields the tools read; the rest of a session is noise here.
  return {
    id,
    title: id,
    status: "active",
    visibility: "promoted",
    running: false,
    attentionRequired: false,
    activity: null,
    parentSessionId: null,
    updatedAt: "2026-10-02T10:00:00.000Z",
    agentId: "agent",
    ...fields,
  } as AgentSession;
}

function harness(
  projects: Record<string, AgentSession[]>,
  hidden = new Set<string>(),
) {
  const delivered: unknown[] = [];
  const interrupted: string[] = [];
  const started: unknown[] = [];
  const followed: unknown[] = [];
  const names: Record<string, string> = { p1: "Work", p2: "Website" };
  const access: AssistantAccess = {
    projects: async () =>
      Object.keys(projects).map((id) => ({ id, name: names[id] ?? id })),
    list: async (projectId) => projects[projectId] ?? [],
    get: async (projectId, sessionId) => {
      const found = [
        ...(projects[projectId] ?? []),
        ...(projectId === "p1"
          ? [chat(ASSISTANT, { agentId: "assistant:agent" })]
          : []),
      ].find((session) => session.id === sessionId);
      if (!found) throw new Error("not found");
      return {
        ...found,
        snapshot: { items: [], turns: [], requests: [] },
      } as unknown as AgentSessionDetail;
    },
    deliver: async (projectId, sessionId, input) => {
      delivered.push({ projectId, sessionId, ...input });
    },
    interrupt: async (projectId, sessionId) => {
      interrupted.push(`${projectId}/${sessionId}`);
    },
    agents: async (projectId) => [
      { id: "agent", name: "Claude" },
      { id: `project:${projectId}:reviewer`, name: "PR reviewer" },
    ],
    start: async (projectId, assistantSessionId, input) => {
      started.push({ projectId, assistantSessionId, ...input });
    },
    follow: async (input) => {
      followed.push(input);
    },
    hidden: (sessionId) => hidden.has(sessionId),
  };
  const tools = Object.fromEntries(
    assistantTools(access).map((tool) => [tool.name, tool]),
  );
  const context = { projectId: "p1", sessionId: ASSISTANT };
  const call = (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools[name];
    if (!tool) throw new Error(`no ${name}`);
    return tool.execute(input, context);
  };
  return { call, delivered, interrupted, started, followed };
}

describe("the assistant's session tools", () => {
  it("lists the person's chats in every project, the busy ones first", async () => {
    const assistant = harness(
      {
        p1: [
          chat("idle", { updatedAt: "2026-10-02T12:00:00.000Z" }),
          chat("closed", { status: "closed" }),
          chat("archived", { visibility: "archived" }),
          chat("private"),
          chat("private-child", { parentSessionId: "private" }),
          chat("private-grandchild", { parentSessionId: "private-child" }),
          chat("mine-started", { parentSessionId: ASSISTANT }),
        ],
        p2: [
          chat("waiting", { attentionRequired: true }),
          chat("working", { running: true }),
        ],
      },
      // The assistant's own chat stays on this computer too; what it
      // started is still its to see.
      new Set(["private", ASSISTANT]),
    );
    const listed = (await assistant.call("list_sessions")) as {
      session_id: string;
      project: string;
      started_by_you: boolean;
    }[];
    expect(listed.map((session) => session.session_id)).toEqual([
      "working",
      "waiting",
      "idle",
      "mine-started",
    ]);
    expect(listed[0]?.project).toBe("Website");
    expect(
      listed.find((s) => s.session_id === "mine-started")?.started_by_you,
    ).toBe(true);
    const website = (await assistant.call("list_sessions", {
      project: "website",
    })) as unknown[];
    expect(website).toHaveLength(2);
  });

  it("messages and stops a chat it did not start, in any project", async () => {
    const assistant = harness({
      p1: [],
      p2: [chat("build", { running: true })],
    });
    await assistant.call("message_session", {
      session_id: "build",
      message: "Use the release branch",
      delivery_mode: "queue",
    });
    expect(assistant.delivered).toEqual([
      {
        projectId: "p2",
        sessionId: "build",
        content: "Use the release branch",
        mode: "queue",
        author: {
          kind: "agent",
          sessionId: ASSISTANT,
          agentId: "assistant:agent",
        },
        authorProjectId: "p1",
      },
    ]);
    expect(await assistant.call("stop_session", { session_id: "build" })).toBe(
      "Stopped.",
    );
    expect(assistant.interrupted).toEqual(["p2/build"]);
  });

  it("starts work with a brief that leads back to the assistant", async () => {
    const assistant = harness({ p1: [] });
    await assistant.call("start_session", {
      request: "Tidy the docs folder",
      title: "Tidy the docs",
    });
    const [start] = assistant.started as {
      projectId: string;
      assistantSessionId: string;
      title: string;
      task: string;
    }[];
    expect(start).toMatchObject({
      projectId: "p1",
      assistantSessionId: ASSISTANT,
      title: "Tidy the docs",
    });
    // The relay, where to read what was said, and how to reach the person.
    expect(start?.task).toContain("Tidy the docs folder");
    expect(start?.task).toContain(`read_project_session`);
    expect(start?.task).toContain(
      `send_project_session_message (session_id ${ASSISTANT}, delivery_mode queue)`,
    );
    expect(start?.task).toContain('"Tidy the docs:"');
  });

  it("starts work on an agent the person names", async () => {
    const assistant = harness({ p1: [] });
    await assistant.call("start_session", {
      request: "Review the open pull request",
      title: "Review the PR",
      agent: "the reviewer agent",
    });
    expect(assistant.started).toEqual([
      expect.objectContaining({ agentId: "project:p1:reviewer" }),
    ]);
    await expect(
      assistant.call("start_session", {
        request: "Write the release notes",
        title: "Release notes",
        agent: "writer",
      }),
    ).rejects.toThrow(
      "No agent called writer. The agents here: Claude, PR reviewer.",
    );
  });

  it("follows a chat's notes, and stops", async () => {
    const assistant = harness({ p2: [chat("build", { title: "Build" })] });
    expect(
      await assistant.call("follow_session", { session_id: "build" }),
    ).toBe("Following.");
    expect(
      await assistant.call("follow_session", {
        session_id: "build",
        follow: false,
      }),
    ).toBe("Stopped following.");
    expect(assistant.followed).toEqual([
      {
        follower: { projectId: "p1", sessionId: ASSISTANT },
        followed: { projectId: "p2", sessionId: "build" },
        title: "Build",
        on: true,
      },
      expect.objectContaining({ on: false }),
    ]);
  });

  it("never touches a private chat, what it started, or itself", async () => {
    const assistant = harness(
      {
        p1: [
          chat("private"),
          chat("private-child", { parentSessionId: "private" }),
        ],
      },
      new Set(["private"]),
    );
    await expect(
      assistant.call("read_session", { session_id: "private" }),
    ).rejects.toThrow(/not available/);
    await expect(
      assistant.call("message_session", {
        session_id: "private-child",
        message: "hello",
      }),
    ).rejects.toThrow(/not available/);
    await expect(
      assistant.call("stop_session", { session_id: ASSISTANT }),
    ).rejects.toThrow(/not available/);
  });
});
