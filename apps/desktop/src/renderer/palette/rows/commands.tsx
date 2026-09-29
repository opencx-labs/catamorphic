import {
  ArrowRight,
  Command,
  Sparkles,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import { useMemo, useRef } from "react";
import {
  type ActionDefinition,
  type ActionId,
  BUILTIN_ACTIONS,
  type KeybindingAction,
} from "../../../shared/actions.js";
import { formatBinding, useKeybindings } from "../../lib/keybindings.js";
import { lucideIcon } from "../../lib/lucide-icon.js";
import { type SkillInfo, skillsForAgent } from "../../lib/skills.js";
import { usePaletteHost } from "../host.js";
import { PICKER_ACTIONS } from "../modes/choices.js";
import type { PaletteHighlight, PaletteItem } from "../types.js";

/** Commands that act on a specific surface accent it while highlighted. */
const ACTION_HIGHLIGHTS: Partial<Record<ActionId, PaletteHighlight>> = {
  "switch-agent": "chat",
  "change-effort": "chat-if-focused",
  "change-permission-mode": "chat-if-focused",
  "switch-model": "chat-if-focused",
  "close-tab": "close",
};

/**
 * Command rows: the shared action registry (one entry yields the shortcut,
 * the Settings row, the agent doc and this row), terminal macros, project
 * starters, skills, projects and profiles.
 */
export function useCommandRows({
  enterMode,
  skills,
  agentSkills,
}: {
  enterMode: (mode: string) => void;
  skills: SkillInfo[];
  /** The target agent's skill setting, if it has one. */
  agentSkills: Parameters<typeof skillsForAgent>[1];
}) {
  const {
    projects,
    activeProjectId,
    profiles,
    activeProfileId,
    onSelectProject,
    onSwitchProfile,
    onSendToAgent,
    startingActions,
    onRunSkill,
    actionHandlers,
    terminalMacros,
    onRunTerminalMacro,
    actionAvailability,
    focusedChat,
    incognitoAllowed = true,
  } = usePaletteHost();
  const keybindings = useKeybindings();
  // Action rows come straight from the shared registry — one entry there
  // yields the shortcut, the Settings row, the agent doc, and this row.
  // Handlers are read through a ref: the map is rebuilt every app render
  // (closures over fresh state), and letting it invalidate this memo
  // would cascade into the results memo and the FLIP pass per render.
  const actionHandlersRef = useRef(actionHandlers);
  actionHandlersRef.current = actionHandlers;
  const macroHandlerRef = useRef(onRunTerminalMacro);
  macroHandlerRef.current = onRunTerminalMacro;
  const hasFocusedChat = focusedChat !== null;
  const actionItems = useMemo<PaletteItem[]>(() => {
    const available = BUILTIN_ACTIONS.filter(
      (action: ActionDefinition) =>
        !action.hiddenInPalette &&
        actionAvailability?.[action.id as ActionId] !== false &&
        // Session-scoped: only offered while a chat is focused.
        (action.id !== "switch-agent" || hasFocusedChat) &&
        // Project policy (ADR 0062): incognito may be disabled here.
        (action.id !== "new-incognito-chat" || incognitoAllowed),
    );
    // With a chat focused, the commands that act on THAT chat lead the
    // list — they're what "change the agent/model/effort" almost always
    // means in the moment, and ties in fuzzy scores resolve by this order.
    const chatScoped = new Set([
      "switch-agent",
      "switch-model",
      "change-effort",
      "change-permission-mode",
    ]);
    const ordered = hasFocusedChat
      ? [
          ...available.filter((action) => chatScoped.has(action.id)),
          ...available.filter((action) => !chatScoped.has(action.id)),
        ]
      : available;
    const commands = ordered.map((action): PaletteItem => {
      const targetPicker = PICKER_ACTIONS[action.id];
      return {
        id: `action:${action.id}`,
        icon: lucideIcon(action.icon) ?? Command,
        label: action.label,
        keywords: [...action.keywords],
        shortcut:
          action.id in keybindings
            ? formatBinding(keybindings[action.id as KeybindingAction])
            : undefined,
        kind: "action" as const,
        category: "command",
        usage: `action:${action.id}`,
        highlight: ACTION_HIGHLIGHTS[action.id],
        // Choice commands swap palette state in place (like mode rows);
        // everything else runs the shared handler.
        ...(targetPicker ? { commit: "stay" as const } : {}),
        run: targetPicker
          ? () => enterMode(targetPicker)
          : (mode) => actionHandlersRef.current[action.id](mode),
      };
    });
    return [
      ...commands,
      ...terminalMacros.map(
        (macro): PaletteItem => ({
          id: `macro:${macro.id}`,
          icon: SquareTerminal,
          label: macro.name,
          detail: "Macro",
          keywords: ["macro", "terminal", macro.command],
          shortcut: formatBinding(macro.shortcut),
          kind: "action",
          category: "command",
          usage: `macro:${macro.id}`,
          run: (mode) => macroHandlerRef.current(macro, mode),
        }),
      ),
    ];
  }, [
    keybindings,
    hasFocusedChat,
    enterMode,
    incognitoAllowed,
    terminalMacros,
    actionAvailability,
  ]);

  const startingActionItems = useMemo<PaletteItem[]>(
    () =>
      startingActions.map(
        (action, index): PaletteItem => ({
          id: `starter:${index}:${action.label}`,
          icon: Sparkles,
          label: action.label,
          detail: "Start with your project agent",
          keywords: [action.label, "start", "project", "agent"],
          kind: "navigate",
          category: "command",
          usage: `starter:${action.label}`,
          run: (mode) =>
            onSendToAgent(
              action.prompt,
              mode === "tab" ? "tab" : "float",
              action.agentId,
            ),
        }),
      ),
    [startingActions, onSendToAgent],
  );

  // Skills as commands (ADR 0052): a row is just a message send — into the
  // focused chat when one exists (an action, chat highlighted like other
  // scoped commands), else a new chat that honors the commit mode.
  const skillItems = useMemo<PaletteItem[]>(
    () =>
      skillsForAgent(skills, agentSkills).map((skill) => ({
        id: `skill:${skill.name}`,
        icon: Sparkles,
        // The pretty title fronts the row; the slug stays a keyword so
        // technical users typing the exact name still hit it.
        label: skill.title,
        detail: skill.source === "host" ? "App skill" : "Skill",
        keywords: [
          skill.name,
          skill.title,
          "skill",
          "use",
          ...skill.description.split(/\s+/).slice(0, 12),
        ],
        kind: hasFocusedChat ? ("action" as const) : ("navigate" as const),
        category: "resource" as const,
        usage: `skill:${skill.name}`,
        highlight: "chat-if-focused" as const,
        run: (mode) => onRunSkill(skill.name, mode === "tab" ? "tab" : "float"),
      })),
    [skills, agentSkills, hasFocusedChat, onRunSkill],
  );

  const projectItems = useMemo<PaletteItem[]>(
    () =>
      projects
        .filter((project) => project.id !== activeProjectId)
        .map((project) => ({
          id: `project:${project.id}`,
          icon: ArrowRight,
          label: `Go to ${project.name}`,
          detail: "Project",
          keywords: [project.name, "go to", "project", "switch", "open"],
          kind: "action" as const,
          category: "resource" as const,
          usage: `project:${project.id}`,
          run: () => onSelectProject(project.id),
        })),
    [projects, activeProjectId, onSelectProject],
  );

  const profileItems = useMemo<PaletteItem[]>(
    () =>
      profiles
        .filter((profile) => profile.id !== activeProfileId)
        .map((profile) => ({
          id: `profile:${profile.id}`,
          icon: UserRound,
          label: `Switch to ${profile.name}`,
          detail: "Profile",
          keywords: [profile.name, "switch to", "profile", "account"],
          kind: "action" as const,
          category: "resource" as const,
          usage: `profile:${profile.id}`,
          run: () => onSwitchProfile(profile),
        })),
    [profiles, activeProfileId, onSwitchProfile],
  );

  const commandItems = useMemo(
    () => [...actionItems, ...skillItems, ...projectItems, ...profileItems],
    [actionItems, skillItems, projectItems, profileItems],
  );
  return {
    actionItems,
    startingActionItems,
    skillItems,
    projectItems,
    profileItems,
    commandItems,
  };
}
