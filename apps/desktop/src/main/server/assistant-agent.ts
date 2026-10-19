import type { AgentDelegationPolicy } from "@catamorphic/core";
import type { ExtraTool } from "@catamorphic/sandbox";
import { z } from "zod";

/** The route to the person's own agent: where work goes by default. */
export const ASSISTANT_WORK_ROUTE = "work";
/** The route to an agent the person names. */
export const ASSISTANT_NAMED_ROUTE = "named";

/**
 * Sessions the assistant starts run on its base agent, or on any agent
 * the person names.
 */
export function assistantDelegation(
  baseAgentId: string,
): AgentDelegationPolicy {
  return {
    enabled: true,
    maxConcurrentChildren: 10,
    routes: [
      {
        id: ASSISTANT_WORK_ROUTE,
        target: baseAgentId,
        allowFurtherDelegation: true,
      },
      { id: ASSISTANT_NAMED_ROUTE, target: "*", allowFurtherDelegation: true },
    ],
  };
}

/**
 * Work's own session tools reach this project's sessions only; the
 * assistant's reach the person's chats in every project, and its sessions
 * report back through it. One set of each, so the assistant has its own.
 */
const REPLACED = new Set([
  "spawn_subsession",
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

/** The base agent's tools, with the assistant's session tools. */
export function assistantHostTools(
  workspace: readonly ExtraTool[],
  sessions: readonly ExtraTool[],
): ExtraTool[] {
  return [...withoutReplacedTools(workspace), ...sessions];
}

/**
 * The workspace tools that look at or act in a window, and which calls of
 * them: the assistant's follow the person to the window they are in (ADR
 * 0265), wherever its own chat lives. Its own terminals stay with its chat.
 */
const FOLLOW_THE_PERSON: Record<
  string,
  (input: Record<string, unknown>) => boolean
> = {
  workspace_overview: () => true,
  read_tab: () => true,
  open_surface: () => true,
  point_at: () => true,
  open_browser: () => true,
  browser_snapshot: () => true,
  browser_act: () => true,
  surface_control: (input) => String(input.key).startsWith("browser:"),
};

/** The tools that look at another project's window when it is named. */
const NAME_A_PROJECT = new Set(["workspace_overview", "read_tab"]);

/** The tab a call is about, when it names one. */
function tabOf(tool: string, input: Record<string, unknown>): string | null {
  const key = tool === "point_at" ? input.target : input.key;
  return typeof key === "string" ? key : null;
}

/**
 * Tabs the assistant saw in another project's window: what it does with
 * them goes there. Tab keys are unique across windows.
 */
const seenElsewhere = new Map<string, string>();
const SEEN_TABS = 500;

function remember(overview: unknown, projectId: string): void {
  const tabs =
    overview && typeof overview === "object" && "tabs" in overview
      ? overview.tabs
      : null;
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    const key: unknown = tab && typeof tab === "object" ? tab.key : null;
    if (typeof key !== "string") continue;
    seenElsewhere.delete(key);
    seenElsewhere.set(key, projectId);
  }
  for (const key of seenElsewhere.keys()) {
    if (seenElsewhere.size <= SEEN_TABS) break;
    seenElsewhere.delete(key);
  }
}

/**
 * The assistant's window tools, acting where the person is, or in another
 * project's window it names (ADR 0265).
 */
export function inThePersonsWindow<T extends ExtraTool>(
  tools: readonly T[],
  windows: {
    /** The project in front of the window the person is in. */
    personProject(): string | null;
    /** One of the person's projects, by its name. */
    projectNamed(name: string): Promise<string | null>;
  },
): T[] {
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
          (follows(rest) ? windows.personProject() : null);
        const result = await tool.execute(
          names ? rest : input,
          projectId ? { ...context, projectId } : context,
        );
        if (elsewhere && tool.name === "workspace_overview")
          remember(result, elsewhere);
        return result;
      },
    };
  });
}
