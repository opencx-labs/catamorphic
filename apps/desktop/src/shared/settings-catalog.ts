import { BUILTIN_ACTIONS, KEYBINDING_ACTIONS } from "./actions.js";
import { SETTING_KEYS, SETTINGS } from "./settings.js";
import { THEME_TOKENS, TOKEN_LABELS } from "./theme-tokens.js";

export interface SettingsDestination {
  id: string;
  requestId: string;
}
export interface SettingsEntry {
  id: string;
  label: string;
  category:
    | "agents"
    | "connections"
    | "appearance"
    | "workspace"
    | "macros"
    | "shortcuts"
    | "notifications"
    | "import";
  keywords: string[];
}

/** Search metadata and stable navigation ids, shared by the UI and agent reference. */
export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  ...SETTING_KEYS.map((key): SettingsEntry => {
    const definition = SETTINGS[key];
    return {
      id: key,
      label: SETTINGS[key].label,
      category:
        key === "terminalMacros"
          ? "macros"
          : key === "terminalAppearance"
            ? "appearance"
            : key === "notificationSounds" || key === "desktopNotifications"
              ? "notifications"
              : "workspace",
      keywords: [
        key,
        ...("options" in definition ? Object.values(definition.options) : []),
        ...("description" in definition ? [definition.description] : []),
        ...(key === "tabPlacement"
          ? ["chrome", "horizontal", "vertical", "sidebar"]
          : []),
        ...(key === "tabFrame" ? ["border", "rounded", "inset"] : []),
      ],
    };
  }),
  {
    id: "theme.selection",
    label: "Theme",
    category: "appearance",
    keywords: ["dark", "light", "system", "colors", "preset", "appearance"],
  },
  {
    id: "theme.fonts.sans",
    label: "Interface font",
    category: "appearance",
    keywords: ["font", "typeface", "sans", "text"],
  },
  {
    id: "theme.fonts.mono",
    label: "Monospace font",
    category: "appearance",
    keywords: ["font", "code", "editor", "terminal", "mono"],
  },
  ...THEME_TOKENS.map(
    (token): SettingsEntry => ({
      id: `theme.overrides.${token}`,
      label: `${TOKEN_LABELS[token]} color`,
      category: "appearance",
      keywords: ["theme", "color", token],
    }),
  ),
  ...BUILTIN_ACTIONS.filter((action) =>
    KEYBINDING_ACTIONS.some((key) => key === action.id),
  ).map(
    (action): SettingsEntry => ({
      id: `shortcut.${action.id}`,
      label: `${action.label} shortcut`,
      category: "shortcuts",
      keywords: ["keyboard", "binding", "hotkey", ...action.keywords],
    }),
  ),
  {
    id: "sidebar",
    label: "Sidebar configuration",
    category: "workspace",
    keywords: ["sidebar", "widgets", "sections", "customize"],
  },
  {
    id: "agents",
    label: "Agent configuration",
    category: "agents",
    keywords: [
      "model",
      "harness",
      "accounts",
      "authentication",
      "default agent",
      "permissions",
    ],
  },
  {
    id: "connections",
    label: "Connections",
    category: "connections",
    keywords: ["connector", "mcp", "plugins", "tools", "accounts"],
  },
  {
    id: "import",
    label: "Import from browser",
    category: "import",
    keywords: ["bookmarks", "passwords", "history", "chrome", "arc"],
  },
];
export const SETTINGS_BY_ID = new Map(
  SETTINGS_CATALOG.map((entry) => [entry.id, entry]),
);
