import { CircleDot, Sparkles, SquareSlash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenMode as CommitMode } from "../../../shared/open-mode.js";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { useAgentCommands } from "../../lib/agent-commands.js";
import type { AgentInfo } from "../../lib/desktop-api.js";
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

const entryIcon = (entry: SkillEntry) =>
  entry.kind === "status"
    ? CircleDot
    : entry.kind === "command"
      ? SquareSlash
      : Sparkles;

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
