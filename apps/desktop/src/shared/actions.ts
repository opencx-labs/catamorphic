/**
 * The single source of truth for app actions. Everything that shows an
 * action anywhere derives from this list: keybinding defaults and the
 * action union (main + renderer), Settings labels, the config agent's
 * action descriptions, and the command palette's action rows.
 *
 * Deliberately plain data with no electron/React imports so both
 * processes can consume it. Icons are renderer-only and live in a
 * lookup beside the palette, keyed by action id.
 *
 * Future plugins: contributed actions would be `ActionDefinition`s
 * appended at runtime (with ids namespaced like "plugin-name:action"),
 * so consumers should treat the registry as a list to iterate, not a
 * closed set — only `BUILTIN_ACTIONS`-derived types assume closedness.
 */
export interface ActionDefinition {
  id: string;
  /** Human label: Settings rows and the palette row. */
  label: string;
  /** Prose for the config agent ("open a new tab (the command palette)"). */
  description: string;
  /** "Cmd+T"-style binding, or null for palette-only actions. */
  defaultBinding: string | null;
  /** Palette search synonyms, beyond the label itself. */
  keywords: string[];
  /** Hidden from the palette (e.g. the palette-openers themselves). */
  hiddenInPalette?: boolean;
}

export const BUILTIN_ACTIONS = [
  {
    id: "new-tab",
    label: "New tab",
    description: "open a new tab (the command palette)",
    defaultBinding: "Cmd+T",
    keywords: ["tab", "palette", "search"],
    hiddenInPalette: true,
  },
  {
    id: "command-palette",
    label: "Command palette",
    description: "open the command palette overlay",
    defaultBinding: "Cmd+P",
    keywords: [],
    hiddenInPalette: true,
  },
  {
    id: "new-floating-chat",
    label: "New floating chat",
    description: "open the small floating chat",
    defaultBinding: "Cmd+N",
    keywords: ["chat", "assistant", "agent", "ai", "quick"],
  },
  {
    id: "new-browser-tab",
    label: "New browser tab",
    description: "open a new browser tab",
    defaultBinding: "Cmd+Alt+T",
    keywords: ["browser", "web", "page", "open"],
  },
  {
    id: "reopen-tab",
    label: "Reopen closed tab",
    description:
      "restore the most recently closed tab (its split partner too, when it had one)",
    defaultBinding: "Cmd+Shift+T",
    keywords: ["reopen", "restore", "closed", "tab", "undo", "recover"],
  },
  {
    id: "toggle-chat-minimized",
    label: "Minimize/restore chat",
    description:
      "minimize the active chat to a bubble, or pop the bubble back open as a floating chat",
    defaultBinding: "Cmd+M",
    keywords: ["chat", "minimize", "restore", "bubble", "collapse", "expand"],
  },
  {
    id: "chat-to-tab",
    label: "Open chat as tab",
    description: "expand the active chat into a full workspace tab",
    defaultBinding: "Cmd+Shift+M",
    keywords: ["chat", "tab", "maximize", "expand", "full", "screen"],
  },
  {
    id: "split-view",
    label: "Split with previous tab",
    description:
      "tile the active tab beside the previously focused one; press again to unsplit",
    defaultBinding: "Cmd+\\",
    keywords: ["split", "tile", "side", "pane", "view", "two", "columns"],
  },
  {
    id: "prev-chat",
    label: "Previous chat",
    description: "show the previous chat in the floating dock",
    defaultBinding: "Cmd+,",
    keywords: [
      "chat",
      "previous",
      "left",
      "cycle",
      "switch",
      "dock",
      "floating",
    ],
  },
  {
    id: "next-chat",
    label: "Next chat",
    description: "show the next chat in the floating dock",
    defaultBinding: "Cmd+.",
    keywords: ["chat", "next", "right", "cycle", "switch", "dock", "floating"],
  },
  {
    id: "prev-tab",
    label: "Previous tab",
    description: "activate the tab to the left",
    defaultBinding: "Cmd+[",
    keywords: ["tab", "previous", "left", "cycle", "switch"],
  },
  {
    id: "next-tab",
    label: "Next tab",
    description: "activate the tab to the right",
    defaultBinding: "Cmd+]",
    keywords: ["tab", "next", "right", "cycle", "switch"],
  },
  {
    id: "new-terminal-tab",
    label: "New terminal",
    description: "open a terminal tab in the project folder",
    defaultBinding: "Ctrl+`",
    keywords: ["terminal", "shell", "console", "cli", "command line"],
  },
  {
    id: "new-editor-tab",
    label: "New editor",
    description: "open a code editor tab (pick a project file)",
    defaultBinding: null,
    keywords: ["editor", "code", "file", "open", "monaco", "edit"],
  },
  {
    id: "toggle-sidebar",
    label: "Toggle sidebar",
    description: "show/hide the sidebar",
    defaultBinding: "Cmd+B",
    keywords: ["sidebar", "hide", "show", "collapse", "expand", "panel"],
  },
  {
    id: "close-tab",
    label: "Close tab",
    description: "close the focused chat or tab",
    defaultBinding: "Cmd+W",
    keywords: ["close", "tab", "quit", "dismiss"],
  },
  {
    id: "setup-agent",
    label: "Set up a new agent…",
    description:
      "open the agent setup wizard (Claude Code, Codex, API key, or free models)",
    defaultBinding: null,
    keywords: [
      "agent",
      "setup",
      "add",
      "new",
      "claude",
      "codex",
      "openrouter",
      "free",
    ],
  },
  {
    id: "default-agent",
    label: "Change default agent…",
    description:
      "pick which configured AI agent answers new chats — in the active project (your override) or globally",
    defaultBinding: null,
    keywords: [
      "switch",
      "agent",
      "default",
      "model",
      "claude",
      "codex",
      "built-in",
      "ai",
    ],
  },
  {
    id: "configure-agent",
    label: "Configure agent…",
    description:
      "open an agent's configuration: model, effort, mode, instructions, memory, connections, skills, tool access, auth (ADR 0056)",
    defaultBinding: null,
    keywords: [
      "agent",
      "configure",
      "settings",
      "edit",
      "instructions",
      "prompt",
      "persona",
      "memory",
      "mode",
      "skills",
      "capabilities",
      "tools",
    ],
  },
  {
    id: "switch-agent",
    label: "Switch agent for this chat…",
    description:
      "move the focused chat to another configured agent (its next turn runs there)",
    defaultBinding: null,
    keywords: ["agent", "switch", "chat", "claude", "codex", "built-in", "ai"],
  },
  {
    id: "switch-model",
    label: "Change model…",
    description:
      "change the model of the focused chat's agent, or the default agent when no chat is focused",
    defaultBinding: null,
    keywords: ["model", "switch", "llm", "openrouter", "claude", "gpt", "free"],
  },
  {
    id: "change-effort",
    label: "Change model effort…",
    description:
      "set reasoning effort for the focused chat, or the default agent when no chat is focused",
    defaultBinding: null,
    keywords: [
      "effort",
      "reasoning",
      "thinking",
      "model",
      "low",
      "medium",
      "high",
    ],
  },
  {
    id: "connect-remote-project",
    label: "Connect to a remote project…",
    description:
      "link a folder on this machine to a project on your team's server (paste the invite's connect link)",
    defaultBinding: null,
    keywords: [
      "remote",
      "server",
      "connect",
      "invite",
      "link",
      "team",
      "brain",
    ],
  },
  {
    id: "manage-connectors",
    label: "Manage connectors…",
    description:
      "open the connectors manager: installed MCP servers and plugins, plus search across the MCP registry and plugin marketplaces",
    defaultBinding: null,
    keywords: [
      "mcp",
      "connector",
      "connectors",
      "connection",
      "integration",
      "integrations",
      "plugin",
      "plugins",
      "server",
      "tools",
      "install",
      "add",
      "registry",
      "marketplace",
    ],
  },
  {
    id: "continue-on-mobile",
    label: "Continue on mobile",
    description:
      "show a QR code that opens this workspace — and the focused chat — on your phone",
    defaultBinding: null,
    keywords: [
      "mobile",
      "phone",
      "qr",
      "pair",
      "pairing",
      "handoff",
      "continue",
      "scan",
      "pwa",
    ],
  },
] as const satisfies readonly ActionDefinition[];

/** Union of built-in action ids ("new-tab" | "command-palette" | …). */
export type ActionId = (typeof BUILTIN_ACTIONS)[number]["id"];

/** Built-in actions that have a keybinding (all of them, today). */
export type KeybindingAction = Extract<
  (typeof BUILTIN_ACTIONS)[number],
  { defaultBinding: string }
>["id"];

export type Keybindings = Record<KeybindingAction, string>;

export const DEFAULT_KEYBINDINGS = Object.fromEntries(
  BUILTIN_ACTIONS.filter((action) => action.defaultBinding !== null).map(
    (action) => [action.id, action.defaultBinding],
  ),
) as Keybindings;

export const KEYBINDING_ACTIONS = Object.keys(
  DEFAULT_KEYBINDINGS,
) as KeybindingAction[];

export const ACTION_LABELS = Object.fromEntries(
  BUILTIN_ACTIONS.map((action) => [action.id, action.label]),
) as Record<ActionId, string>;
