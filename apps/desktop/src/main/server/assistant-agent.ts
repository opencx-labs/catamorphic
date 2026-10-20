import type { AgentDelegationPolicy } from "@catamorphic/core";
import type { ExtraTool, ExtraToolContext } from "@catamorphic/sandbox";
import { z } from "zod";

/**
 * Sessions the assistant starts run on its base agent, or on any agent the
 * person names, on any model and effort their harness offers (ADR 0270): a
 * quick voice assistant hands hard work to a stronger model.
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
