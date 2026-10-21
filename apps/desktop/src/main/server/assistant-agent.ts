import type { AgentDelegationPolicy } from "@catamorphic/core";
import type { ExtraTool, ExtraToolContext } from "@catamorphic/sandbox";
import { z } from "zod";

/**
 * Sessions the assistant starts with spawn_subsession, like any agent's
 * (ADR 0271): on the agent it is built on, or any agent the person names,
 * on any model and effort their harness offers: a quick voice assistant
 * hands hard work to a stronger model. It starts no copy of itself.
 */
export function assistantDelegation(
  baseAgentId: string,
): AgentDelegationPolicy {
  return {
    enabled: true,
    maxConcurrentChildren: 10,
    agents: [
      { agent: baseAgentId, model: "any", effort: "any", delegate: true },
      { agent: "*", model: "any", effort: "any", delegate: true },
    ],
  };
}

/**
 * What a session the assistant starts reads first (ADR 0216): where the
 * request came from, and how to reach the person while they are away from
 * the screen. A read-only session cannot message the assistant's chat, so
 * it says everything in its result.
 */
export function assistantTaskBrief(input: {
  assistantSessionId: string;
  title: string;
  request: string;
  readOnly?: boolean;
}): string {
  const reach = input.readOnly
    ? "The person may be away from the screen, talking by voice. This session only reads, so put everything they should hear in your final reply."
    : `The person may be away from the screen, talking by voice. To tell them something that matters, or to ask what only they can answer, send it to the assistant's chat with send_project_session_message (session_id ${input.assistantSessionId}, delivery_mode steer), starting with "${input.title}:". It may be read aloud to them, where a sentence or two of plain words comes across best. Their answer comes back here; keep going on whatever does not depend on it.`;
  return `The person asked for this through their assistant in Work, which relayed it as:

${input.request}

The relay is short and may be slightly off. For what the person actually said, read the assistant's chat, session ${input.assistantSessionId} in this project, with read_project_session.

${reach}

Your final reply goes back to the assistant, which passes it on to the person: a sentence or two up front that sum it up are what it will use.`;
}

/** The longest title a session the assistant starts gets from its task. */
const TITLE_CHARS = 60;

/**
 * A subsession the assistant starts (ADR 0216, 0271): its task in the
 * brief that leads back to the assistant, under the title its messages to
 * the person start with.
 */
export function assistantSubsession(input: {
  assistantSessionId: string;
  task: string;
  title?: string;
  readOnly?: boolean;
}): { task: string; title: string } {
  const task = input.task.replace(/\s+/g, " ").trim();
  if (!task) throw new Error("A subsession task is required");
  const title =
    input.title?.trim() ||
    (task.length > TITLE_CHARS
      ? `${task.slice(0, TITLE_CHARS - 1).trimEnd()}…`
      : task);
  return {
    title,
    task: assistantTaskBrief({
      assistantSessionId: input.assistantSessionId,
      title,
      request: input.task,
      ...(input.readOnly ? { readOnly: true } : {}),
    }),
  };
}

/** Follows a session's notes for the assistant's chat (ADR 0216). */
export type FollowSession = (input: {
  follower: { projectId: string; sessionId: string };
  followed: { projectId: string; sessionId: string };
  title: string;
}) => Promise<void>;

/** How the assistant's spawn_subsession reaches its sessions. */
interface AssistantSpawn {
  follow: FollowSession;
  /** The agent it is built on: its sessions' agent unless one is named. */
  baseAgentId: string;
}

/**
 * The assistant's spawn_subsession: Work's own, on the person's own agent
 * unless it names another, with the task in the brief that leads back to
 * the assistant, and the session's notes followed so the assistant can
 * pass them on.
 */
function briefedSpawn<T extends ExtraTool>(
  spawn: T,
  { follow, baseAgentId }: AssistantSpawn,
): T {
  return {
    ...spawn,
    parameters: {
      ...spawn.parameters,
      agent: z
        .string()
        .min(1)
        .optional()
        .describe(
          "An agent id from your instructions' list; leave out for the person's own agent",
        ),
    },
    execute: async (input, context) => {
      const assistantSessionId = context.sessionId;
      if (!assistantSessionId) return spawn.execute(input, context);
      const briefed = assistantSubsession({
        assistantSessionId,
        task: typeof input.task === "string" ? input.task : "",
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(input.read_only === true ? { readOnly: true } : {}),
      });
      const agent =
        typeof input.agent === "string" && input.agent !== "self"
          ? input.agent
          : baseAgentId;
      const child = await spawn.execute(
        { ...input, ...briefed, agent },
        context,
      );
      const sessionId =
        child && typeof child === "object" && "sessionId" in child
          ? child.sessionId
          : undefined;
      // The child already runs: missing its notes is no reason to fail.
      if (typeof sessionId === "string")
        await follow({
          follower: {
            projectId: context.projectId,
            sessionId: assistantSessionId,
          },
          followed: { projectId: context.projectId, sessionId },
          title: briefed.title,
        }).catch((cause: unknown) =>
          console.warn("[assistant] following a session failed:", cause),
        );
      return child;
    },
  };
}

/**
 * Work's own session tools reach this project's sessions only; the
 * assistant's reach the person's chats in every project. One set of each,
 * so the assistant has its own. It never waits on a session it started:
 * the person may be talking, and the result comes to it anyway.
 */
const REPLACED = new Set([
  "wait_for_subsessions",
  "interrupt_subsession",
  "list_project_sessions",
  "read_project_session",
  "send_project_session_message",
]);

/**
 * Workspace tools a chat discovers that the assistant has at once: it is
 * talked to by voice most, and what the person saw as they spoke is what
 * "this" means (ADR 0265).
 */
export const ASSISTANT_EAGER = new Set(["screen_when_spoken"]);

/** Workspace tools without the session tools the assistant replaces. */
export function withoutReplacedTools<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) => !REPLACED.has(tool.name));
}

/**
 * Work's tools as the assistant has them, served or discovered: without
 * the session tools it replaces, and its spawn_subsession briefed.
 */
export function assistantWorkspaceTools<T extends ExtraTool>(
  input: AssistantSpawn & { tools: readonly T[] },
): T[] {
  return withoutReplacedTools(input.tools).map((tool) =>
    tool.name === "spawn_subsession" ? briefedSpawn(tool, input) : tool,
  );
}

/** The base agent's tools, with the assistant's session tools. */
export function assistantHostTools(
  input: AssistantSpawn & {
    workspace: readonly ExtraTool[];
    sessions: readonly ExtraTool[];
  },
): ExtraTool[] {
  return [
    ...assistantWorkspaceTools({ ...input, tools: input.workspace }),
    ...input.sessions,
  ];
}

/**
 * The assistant's tools that look at the screen, show something or point
 * (ADR 0265): they act where the person is, wherever its own chat lives.
 * What it drives itself stays with its chat, whose turns hand it back:
 * browser tabs it holds, its terminals, the chips on its own chat.
 */
const FOLLOW_THE_PERSON: Record<
  string,
  (input: Record<string, unknown>) => boolean
> = {
  workspace_overview: () => true,
  read_tab: () => true,
  open_surface: () => true,
  point_at: (input) => !String(input.target ?? "").startsWith("chip:"),
};

/** The tools that look at another project's window when it is named. */
const NAME_A_PROJECT = new Set(["workspace_overview", "read_tab"]);

/** Tabs whose keys are unique across windows: what can be remembered. */
const UNIQUE_TAB = /^(browser|terminal|editor|chat):/;
/** Tabs remembered in other projects' windows, at most. */
const SEEN_TABS = 500;

/** The tab a call is about, when it names one. */
function tabOf(tool: string, input: Record<string, unknown>): string | null {
  const key =
    tool === "point_at" || tool === "open_surface" ? input.target : input.key;
  return typeof key === "string" ? key : null;
}

function remember(
  seenElsewhere: Map<string, string>,
  overview: unknown,
  projectId: string,
): void {
  const tabs =
    overview && typeof overview === "object" && "tabs" in overview
      ? overview.tabs
      : null;
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    const key: unknown = tab && typeof tab === "object" ? tab.key : null;
    if (typeof key !== "string" || !UNIQUE_TAB.test(key)) continue;
    seenElsewhere.delete(key);
    seenElsewhere.set(key, projectId);
  }
  for (const key of seenElsewhere.keys()) {
    if (seenElsewhere.size <= SEEN_TABS) break;
    seenElsewhere.delete(key);
  }
}

/**
 * The assistant's window tools, looking where the person is, or at another
 * project's window it names (ADR 0265).
 */
export function inThePersonsWindow<T extends ExtraTool>(
  tools: readonly T[],
  windows: {
    /** The project in front of the window the person is in, for a call. */
    personProject(context: ExtraToolContext): string | null;
    /** One of the person's projects, by its name. */
    projectNamed(name: string): Promise<string | null>;
    /**
     * Tabs it saw in another project's window, by key, and that project:
     * what it does with them goes there. One per profile.
     */
    seenElsewhere: Map<string, string>;
  },
): T[] {
  const { seenElsewhere } = windows;
  return tools.map((tool) => {
    const follows = FOLLOW_THE_PERSON[tool.name];
    if (!follows) return tool;
    const names = NAME_A_PROJECT.has(tool.name);
    return {
      ...tool,
      parameters: names
        ? {
            ...tool.parameters,
            project: z
              .string()
              .optional()
              .describe(
                "Another project's window, by the project's name; by default the window the person is in",
              ),
          }
        : tool.parameters,
      execute: async (input, context) => {
        const { project, ...rest } = input;
        const named =
          names && typeof project === "string" && project.trim()
            ? project.trim()
            : null;
        const elsewhere = named ? await windows.projectNamed(named) : null;
        if (named && !elsewhere)
          throw new Error(
            `No project named "${named}". list_sessions shows the person's projects.`,
          );
        const tab = tabOf(tool.name, rest);
        const projectId =
          elsewhere ??
          (tab ? seenElsewhere.get(tab) : undefined) ??
          (follows(rest) ? windows.personProject(context) : null);
        const own = names ? rest : input;
        if (!projectId || projectId === context.projectId)
          return tool.execute(own, context);
        // Its own folder is not the person's project's: a file named there
        // is found in the window it opens in.
        const { workingDirectory: _home, ...elsewhereContext } = context;
        try {
          const result = await tool.execute(own, {
            ...elsewhereContext,
            projectId,
          });
          if (elsewhere && tool.name === "workspace_overview")
            remember(seenElsewhere, result, elsewhere);
          return result;
        } catch (cause) {
          // A tab of its own chat's (a terminal it started) is not in the
          // person's window: read where it is.
          if (named || tool.name !== "read_tab") throw cause;
          return tool.execute(own, context);
        }
      },
    };
  });
}
