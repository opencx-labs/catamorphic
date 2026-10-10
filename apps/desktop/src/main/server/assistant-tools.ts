import type { SessionMessageAuthor } from "@catamorphic/agent-protocol";
import type { AgentSession, AgentSessionDetail } from "@catamorphic/core";
import type { ExtraTool, ExtraToolContext } from "@catamorphic/sandbox";
import { z } from "zod";
import { voiceChatOf } from "../voice/conversation.js";

/**
 * What the assistant's session tools reach (ADR 0216): every chat of the
 * person's profile, in every one of its projects, as the person.
 */
export interface AssistantAccess {
  /** The projects of the profile that owns this project. */
  projects(projectId: string): Promise<{ id: string; name: string }[]>;
  list(projectId: string): Promise<AgentSession[]>;
  get(projectId: string, sessionId: string): Promise<AgentSessionDetail>;
  deliver(
    projectId: string,
    sessionId: string,
    input: {
      content: string;
      mode: "queue" | "interrupt";
      author: SessionMessageAuthor;
    },
  ): Promise<unknown>;
  interrupt(projectId: string, sessionId: string): Promise<void>;
  /** The agents a session in this project can run on: the person's and the project's. */
  agents(projectId: string): Promise<{ id: string; name: string }[]>;
  /**
   * Starts a session as a child of the assistant's chat: on the
   * assistant's own agent, or on `agentId`. The assistant follows its
   * notes.
   */
  start(
    projectId: string,
    assistantSessionId: string,
    input: { task: string; title: string; agentId?: string },
  ): Promise<unknown>;
  /** The follower hears a chat's notes as it works, or stops hearing them. */
  follow(input: {
    follower: { projectId: string; sessionId: string };
    followed: { projectId: string; sessionId: string };
    title: string;
    on: boolean;
  }): Promise<void>;
  /** Chats the person keeps private (incognito): never listed or touched. */
  hidden(sessionId: string): boolean;
}

const LIST_LIMIT = 25;
const READ_MESSAGES = 20;
const READ_MESSAGE_CHARS = 1_500;

/**
 * What a session the assistant starts reads first (ADR 0216): where the
 * request came from, and how to reach the person while they are away from
 * the screen.
 */
export function assistantTaskBrief(input: {
  assistantSessionId: string;
  title: string;
  request: string;
}): string {
  return `The person asked for this through their assistant in Work, which relayed it as:

${input.request}

The relay is short and may be slightly off. For what the person actually said, read the assistant's chat, session ${input.assistantSessionId} in this project, with read_project_session.

The person may be away from the screen, talking by voice. To tell them something that matters, or to ask what only they can answer, send it to the assistant's chat with send_project_session_message (session_id ${input.assistantSessionId}, delivery_mode queue), starting with "${input.title}:" and in a sentence or two of plain words. Their answer comes back here; keep going on whatever does not depend on it.

Your final reply goes back to the assistant, which passes it on to the person: a sentence or two up front that sum it up are what it will use.`;
}

/**
 * The agent a spoken name means, by its name or file name: "the reviewer
 * agent" is the reviewer.
 */
function namedAgent(
  agents: readonly { id: string; name: string }[],
  spoken: string,
): { id: string; name: string } | undefined {
  const key = (text: string) =>
    text
      .toLowerCase()
      .replace(/\b(the|my|our|agent)\b/g, "")
      .replace(/[^a-z0-9]/g, "");
  const wanted = key(spoken);
  return agents.find(
    (agent) =>
      key(agent.name) === wanted ||
      key(agent.id.split(":").at(-1) ?? "") === wanted,
  );
}

/**
 * The assistant hands work to sessions and manages the person's chats,
 * not only the ones it started: it lists them across the profile's
 * projects, reads one, sends one a message, or stops its turn. A session
 * it starts reports back to it, along the way and when it is done.
 */
export function assistantTools(access: AssistantAccess): ExtraTool[] {
  const locate = async (
    context: ExtraToolContext,
    sessionId: string,
  ): Promise<{
    projectId: string;
    projectName: string;
    detail: AgentSessionDetail;
  }> => {
    if (sessionId === context.sessionId || access.hidden(sessionId))
      throw new Error("That chat is not available.");
    for (const project of await access.projects(context.projectId)) {
      const detail = await access.get(project.id, sessionId).catch(() => null);
      if (detail)
        return { projectId: project.id, projectName: project.name, detail };
    }
    throw new Error("No chat with that id. List the sessions to find it.");
  };
  const author = async (
    context: ExtraToolContext,
  ): Promise<SessionMessageAuthor> => {
    const own = context.sessionId
      ? await access.get(context.projectId, context.sessionId)
      : undefined;
    return {
      kind: "agent",
      sessionId: context.sessionId ?? "",
      agentId: own?.agentId ?? null,
    };
  };
  return [
    {
      name: "start_session",
      description:
        "Hand work to a session that runs in the background, on the person's own agent or on an agent they name. Say what the person wants in a sentence or two, in their words; the session reads this conversation for the rest. It may send you news or a question for the person while it works, and its result comes back here.",
      parameters: {
        request: z.string().min(1).describe("What the person wants done"),
        title: z
          .string()
          .min(1)
          .max(60)
          .describe("A few words naming the work, like Tidy the docs"),
        agent: z
          .string()
          .min(1)
          .optional()
          .describe(
            "An agent the person named, like the reviewer; leave out for their own agent",
          ),
      },
      execute: async (input, context) => {
        if (!context.sessionId) throw new Error("This turn has no chat.");
        let agentId: string | undefined;
        if (typeof input.agent === "string") {
          const agents = await access.agents(context.projectId);
          const agent = namedAgent(agents, input.agent);
          if (!agent)
            throw new Error(
              `No agent called ${input.agent}. The agents here: ${agents.map((candidate) => candidate.name).join(", ")}.`,
            );
          agentId = agent.id;
        }
        const title = String(input.title);
        await access.start(context.projectId, context.sessionId, {
          title,
          task: assistantTaskBrief({
            assistantSessionId: context.sessionId,
            title,
            request: String(input.request),
          }),
          ...(agentId ? { agentId } : {}),
        });
        return "Started. It will report back here.";
      },
    },
    {
      name: "list_sessions",
      description:
        "List the person's chats in all their projects: running ones first, then ones waiting on the person, then the most recently active. Includes the sessions you started.",
      parameters: {
        project: z
          .string()
          .optional()
          .describe("Only chats in the project with this name"),
      },
      execute: async (input, context) => {
        const projects = (await access.projects(context.projectId)).filter(
          (project) =>
            typeof input.project !== "string" ||
            project.name.toLowerCase() === input.project.toLowerCase(),
        );
        const sessions = (
          await Promise.all(
            projects.map(async (project) =>
              (
                await access.list(project.id)
              ).map((session) => ({
                session,
                project: project.name,
              })),
            ),
          )
        )
          .flat()
          .filter(
            ({ session }) =>
              session.id !== context.sessionId &&
              session.status === "active" &&
              session.visibility !== "archived" &&
              !access.hidden(session.id),
          )
          .sort(
            (a, b) =>
              Number(b.session.running) - Number(a.session.running) ||
              Number(b.session.attentionRequired) -
                Number(a.session.attentionRequired) ||
              b.session.updatedAt.localeCompare(a.session.updatedAt),
          )
          .slice(0, LIST_LIMIT);
        return sessions.map(({ session, project }) => ({
          session_id: session.id,
          title: session.title ?? "Untitled chat",
          project,
          running: session.running,
          waiting_on_person: session.attentionRequired,
          activity: session.activity,
          started_by_you: session.parentSessionId === context.sessionId,
          last_active: session.updatedAt,
        }));
      },
    },
    {
      name: "read_session",
      description:
        "Read a chat's recent conversation and whether it is working right now.",
      parameters: {
        session_id: z.string().min(1).describe("From list_sessions"),
      },
      execute: async (input, context) => {
        const { projectName, detail } = await locate(
          context,
          String(input.session_id),
        );
        return {
          title: detail.title ?? "Untitled chat",
          project: projectName,
          running: detail.running,
          messages: voiceChatOf(detail.snapshot)
            .messages.filter((message) => !message.writing)
            .slice(-READ_MESSAGES)
            .map((message) => ({
              role: message.role,
              content: message.text.slice(0, READ_MESSAGE_CHARS),
            })),
        };
      },
    },
    {
      name: "message_session",
      description:
        "Send a chat a message on the person's behalf, queued as its next turn; interrupt only when it must change course right now.",
      parameters: {
        session_id: z.string().min(1).describe("From list_sessions"),
        message: z.string().min(1),
        delivery_mode: z.enum(["queue", "interrupt"]).default("queue"),
      },
      execute: async (input, context) => {
        const { projectId } = await locate(context, String(input.session_id));
        await access.deliver(projectId, String(input.session_id), {
          content: String(input.message),
          mode: input.delivery_mode === "interrupt" ? "interrupt" : "queue",
          author: await author(context),
        });
        return "Sent.";
      },
    },
    {
      name: "follow_session",
      description:
        "Hear a chat's notes as it works, the way you hear the sessions you start, or stop hearing them. For when the person wants to be kept posted on one of their chats.",
      parameters: {
        session_id: z.string().min(1).describe("From list_sessions"),
        follow: z.boolean().default(true).describe("False stops following"),
      },
      execute: async (input, context) => {
        if (!context.sessionId) throw new Error("This turn has no chat.");
        const { projectId, detail } = await locate(
          context,
          String(input.session_id),
        );
        const on = input.follow !== false;
        await access.follow({
          follower: {
            projectId: context.projectId,
            sessionId: context.sessionId,
          },
          followed: { projectId, sessionId: String(input.session_id) },
          title: detail.title ?? "Untitled chat",
          on,
        });
        return on ? "Following." : "Stopped following.";
      },
    },
    {
      name: "stop_session",
      description: "Stop what a chat is doing right now.",
      parameters: {
        session_id: z.string().min(1).describe("From list_sessions"),
      },
      execute: async (input, context) => {
        const { projectId, detail } = await locate(
          context,
          String(input.session_id),
        );
        if (!detail.running) return "It was not working on anything.";
        await access.interrupt(projectId, String(input.session_id));
        return "Stopped.";
      },
    },
  ];
}
