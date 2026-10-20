import { CircleDot, Sparkles, SquareSlash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCommandsResult } from "../../../shared/agent-commands.js";
import type { OpenMode as CommitMode } from "../../../shared/open-mode.js";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { type AgentInfo, desktopApi } from "../../lib/desktop-api.js";
import {
  entryInvocation,
  type SkillEntry,
  skillEntries,
} from "../../lib/skill-entries.js";
import { type SkillInfo, skillsForAgent } from "../../lib/skills.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** The Skills mode (ADR 0270); a chosen skill's instructions are `skill:<name>`. */
export const SKILLS_MODE = "skills";
const CHOSEN_PREFIX = "skill:";

/**
 * Where a committed skill goes: Enter applies it to the chat in front (or
 * starts a floating chat when there is none), ⌘↵ starts a chat in a tab,
 * ⌥↵ a floating one. A palette tab's Enter is ⌘↵: the chat takes the tab.
 */
export function skillTarget(
  mode: CommitMode,
  hasChat: boolean,
): "chat" | "tab" | "float" {
  if (mode === "replace") return hasChat ? "chat" : "float";
  return mode === "floating" ? "float" : "tab";
}

/**
 * The typing a dismissed Skills mode hands back to its composer: the "/"
 * that opened it, a chosen skill's name and whatever was typed after.
 */
export function composerText(modeId: string | null, query: string): string {
  const chosen = modeId?.startsWith(CHOSEN_PREFIX)
    ? modeId.slice(CHOSEN_PREFIX.length)
    : undefined;
  return chosen ? `/${chosen} ${query}` : `/${query}`;
}

const entryIcon = (entry: SkillEntry) =>
  entry.kind === "status"
    ? CircleDot
    : entry.kind === "command"
      ? SquareSlash
      : Sparkles;

/**
 * The chat agent's own commands and skills, fresh on every opening: Claude
 * Code's commands and plugin skills, Codex's skills, read in the chat's
 * checkout. A late answer for another agent or chat never shows.
 */
function useAgentCommands({
  projectId,
  agentId,
  sessionId,
  active,
  refresh,
}: {
  projectId: string | undefined;
  agentId: string | undefined;
  sessionId: string | null;
  active: boolean;
  refresh: number;
}): AgentCommandsResult & { loading: boolean } {
  const request = useMemo(
    () => ({ projectId, agentId, sessionId, active, refresh }),
    [projectId, agentId, sessionId, active, refresh],
  );
  const [catalog, setCatalog] = useState<
    AgentCommandsResult & { request?: typeof request; loading: boolean }
  >({ commands: [], loading: true });
  useEffect(() => {
    if (!request.active || !request.projectId || !request.agentId) return;
    let cancelled = false;
    setCatalog({ request, commands: [], loading: true });
    void desktopApi
      .agentCommands({
        projectId: request.projectId,
        agentId: request.agentId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      })
      .then((result) => {
        if (!cancelled) setCatalog({ ...result, request, loading: false });
      })
      .catch(() => {
        if (!cancelled)
          setCatalog({
            request,
            commands: [],
            loading: false,
            error: "Could not load the agent's commands.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  // One empty list, so rows built from it keep their identity per render.
  if (!projectId || !agentId) return { commands: NO_COMMANDS, loading: false };
  return catalog.request === request
    ? catalog
    : { commands: NO_COMMANDS, loading: active };
}
const NO_COMMANDS: AgentCommandsResult["commands"] = [];

/**
 * Skills as a palette mode (ADR 0270): Work's status for the chat, the
 * shared skills its agent may use, and the agent's own commands. Typing
 * filters; Tab, or Space after a full name, takes the skill's instructions
 * in `skill:<name>`; Enter applies it here, ⌘↵ in a new chat.
 */
export function useSkillModes({
  modeId,
  variant,
  agent,
  skills,
  skillsLoading,
  skillsError,
  refresh,
  onRetry,
  composer,
}: {
  modeId: string | null;
  variant: "overlay" | "tab";
  /** The agent skills go to: the chat's in front, else the default. */
  agent: AgentInfo | undefined;
  skills: SkillInfo[];
  skillsLoading: boolean;
  skillsError?: string;
  /** Bumped on every opening: catalogs are files that change. */
  refresh: number;
  onRetry: () => void;
  composer: string | undefined;
}): PaletteMode[] {
  const { projectId, focusedChat, onRunSkill, actionHandlers } =
    usePaletteHost();
  // Rebuilt on every app render; read when a row runs, so the rows (and
  // the list's motion) keep their identity in between.
  const handlersRef = useRef({ onRunSkill, actionHandlers });
  handlersRef.current = { onRunSkill, actionHandlers };
  const active =
    modeId === SKILLS_MODE || Boolean(modeId?.startsWith(CHOSEN_PREFIX));
  const native = useAgentCommands({
    projectId,
    agentId: agent?.id,
    sessionId: focusedChat?.sessionId ?? null,
    active,
    refresh,
  });
  // A palette tab is consumed by the chat it starts; only the overlay
  // applies a skill to the chat in front.
  const hasChat = variant === "overlay" && focusedChat !== null;
  // The chosen skill, kept while a refresh (Retry, another opening) has its
  // catalog briefly empty: its instructions stay on screen.
  const chosenName = modeId?.startsWith(CHOSEN_PREFIX)
    ? modeId.slice(CHOSEN_PREFIX.length)
    : undefined;
  const [kept, setKept] = useState<SkillEntry>();
  const entries = useMemo(
    () =>
      skillEntries({
        skills: skillsForAgent(skills, agent?.skills),
        commands: native.commands,
        harnessLabel:
          agent?.harness === "codex" ? "Codex skill" : "Claude Code",
        status: hasChat,
      }),
    [skills, agent?.skills, agent?.harness, native.commands, hasChat],
  );
  const found = chosenName
    ? entries.find((entry) => entry.name === chosenName)
    : undefined;
  useEffect(() => {
    // By name: entries are rebuilt as catalogs refresh, and a kept copy
    // of the same skill must not set state again.
    if (found && found.name !== kept?.name) setKept(found);
  }, [found, kept]);
  const chosen = found ?? (kept?.name === chosenName ? kept : undefined);
  return useMemo(() => {
    // What Enter and its modifiers do here (skillTarget): a palette tab's
    // Enter is already a chat in the tab, an overlay's without a chat a
    // floating one.
    const commitHints = hasChat
      ? [
          { keycap: "↵", label: "this chat" },
          { keycap: "⌘↵", label: "new chat" },
          { keycap: "⌥↵", label: "floating chat" },
        ]
      : variant === "tab"
        ? [
            { keycap: "↵", label: "new chat" },
            { keycap: "⌥↵", label: "floating chat" },
          ]
        : [
            { keycap: "↵", label: "new chat" },
            { keycap: "⌘↵", label: "chat in a tab" },
          ];
    const run = (entry: SkillEntry, instructions: string, mode: CommitMode) => {
      if (entry.kind === "status") {
        handlersRef.current.actionHandlers["session-status"]();
        return;
      }
      const target = skillTarget(mode, hasChat);
      // An agent's own command means something only to that agent.
      const own = entry.kind === "command" || Boolean(entry.skillPath);
      handlersRef.current.onRunSkill({
        message: entryInvocation(entry, instructions),
        target,
        ...(composer ? { composer } : {}),
        ...(target !== "chat" && own && agent ? { agentId: agent.id } : {}),
      });
    };
    const rows = entries.map(
      (entry): PaletteItem => ({
        id: `skills:${entry.name}`,
        icon: entryIcon(entry),
        label: entry.title,
        detail: entry.description || entry.source,
        keywords: [
          entry.name,
          entry.source,
          ...entry.description.split(/\s+/).slice(0, 12),
        ],
        // Skills open a chat with ⌘↵, like a page opens a tab.
        kind: entry.kind === "status" ? "action" : "navigate",
        category: "command",
        usage: entry.kind === "status" ? undefined : `skill:${entry.name}`,
        highlight: "chat-if-focused",
        ...(entry.kind === "status"
          ? {}
          : {
              input: {
                mode: `${CHOSEN_PREFIX}${entry.name}`,
                names: [entry.name, entry.title],
                run: (instructions, mode) => run(entry, instructions, mode),
              },
            }),
        run: (mode) => run(entry, "", mode),
      }),
    );
    const error = skillsError ?? native.error;
    const loading = skillsLoading || native.loading;
    const status: PaletteItem[] = loading
      ? [
          {
            id: "skills:loading",
            icon: Sparkles,
            label: "Loading skills…",
            keywords: [],
            kind: "action",
            disabled: true,
            run: () => {},
          },
        ]
      : error
        ? [
            {
              id: "skills:error",
              icon: Sparkles,
              label: error,
              detail: "Press Enter to retry",
              keywords: [],
              kind: "action",
              commit: "stay",
              run: onRetry,
            },
          ]
        : [];
    const modes: PaletteMode[] = [
      {
        id: SKILLS_MODE,
        chip: "Skills",
        icon: Sparkles,
        label: "Use a skill",
        description: "Skills and the chat agent's own commands",
        placeholder: "Search skills…",
        names: projectId ? BUILTIN_PALETTE_TRIGGERS.skills : undefined,
        highlight: "chat-if-focused",
        commitHints: [{ keycap: "Tab", label: "instructions" }, ...commitHints],
        // A failure leads, where Enter retries it; loading trails the rows.
        rows: {
          kind: "list",
          items:
            error && !loading ? [...status, ...rows] : [...rows, ...status],
          zero: "recent",
        },
      },
    ];
    if (chosen)
      modes.push({
        id: `${CHOSEN_PREFIX}${chosen.name}`,
        chip: chosen.title,
        icon: entryIcon(chosen),
        placeholder: chosen.argumentHint || "Add instructions, or press Enter…",
        parent: SKILLS_MODE,
        highlight: "chat-if-focused",
        commitHints,
        rows: {
          kind: "compute",
          rows: (instructions) => [
            {
              id: `skill-run:${chosen.name}`,
              icon: entryIcon(chosen),
              label:
                chosen.kind === "command"
                  ? `Run ${chosen.title}`
                  : `Use ${chosen.title}`,
              detail: chosen.description || chosen.source,
              keywords: [],
              kind: "navigate",
              category: "command",
              usage: `skill:${chosen.name}`,
              highlight: "chat-if-focused",
              run: (mode) => run(chosen, instructions, mode),
            },
          ],
        },
      });
    return modes;
  }, [
    entries,
    hasChat,
    variant,
    composer,
    agent,
    skillsError,
    native.error,
    skillsLoading,
    native.loading,
    onRetry,
    projectId,
    chosen,
  ]);
}
