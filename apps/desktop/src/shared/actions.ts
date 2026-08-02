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
    defaultBinding: "Cmd+Shift+T",
    keywords: ["browser", "web", "page", "open"],
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
