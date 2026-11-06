import { BUILTIN_ACTIONS, KEYBINDING_ACTIONS } from "./actions.js";
import { SETTING_KEYS, SETTINGS, type SettingKey } from "./settings.js";
import { THEME_TOKENS, TOKEN_LABELS } from "./theme-tokens.js";

export interface SettingsDestination {
  id: string;
  requestId: string;
}
export type SettingsCategory =
  | "agents"
  | "connections"
  | "appearance"
  | "workspace"
  | "macros"
  | "shortcuts"
  | "notifications"
  | "voice"
  | "import";
export interface SettingsEntry {
  id: string;
  label: string;
  category: SettingsCategory;
  keywords: string[];
  /** Offered only on macOS. */
  macOnly?: boolean;
}

/** The Settings category that shows a preference; every preference has one. */
export function settingCategory(key: SettingKey): SettingsCategory {
  return key === "terminalMacros"
    ? "macros"
    : key === "terminalAppearance" || key === "codeTheme"
      ? "appearance"
      : key === "notificationSounds" || key === "desktopNotifications"
        ? "notifications"
        : "workspace";
}

/** Search metadata and stable navigation ids, shared by the UI and agent reference. */
export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  {
    id: "dockIcon",
    label: "Dock icon",
    category: "appearance",
    keywords: [
      "macos",
      "application",
      "icon",
      "image",
      "customize",
      "png",
      "jpeg",
    ],
    macOnly: true,
  },
  {
    id: "defaultBrowser",
    label: "Default browser",
    category: "workspace",
    keywords: ["default", "browser", "links", "http", "https", "system"],
  },
  ...SETTING_KEYS.map((key): SettingsEntry => {
    const definition = SETTINGS[key];
    return {
      id: key,
      label: SETTINGS[key].label,
      category: settingCategory(key),
      keywords: [
        key,
        ...("options" in definition ? Object.values(definition.options) : []),
        ...("description" in definition ? [definition.description] : []),
        ...(key === "tabPlacement"
          ? ["chrome", "horizontal", "vertical", "sidebar"]
          : []),
        ...(key === "browserTabSleep"
          ? ["memory", "saver", "inactive", "discard", "browser", "tabs"]
          : []),
        ...(key === "switchToOpenTab"
          ? ["existing", "duplicate", "reuse", "already open", "links", "tabs"]
          : []),
        ...(key === "contentFrame"
          ? ["border", "rounded", "inset", "window", "frame"]
          : []),
        ...(key === "windowButtons"
          ? ["traffic lights", "close", "minimize", "zoom", "title bar"]
          : []),
      ],
      ...("macOnly" in definition ? { macOnly: definition.macOnly } : {}),
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
    id: "workspace",
    label: "Sidebars and palette modes",
    category: "workspace",
    keywords: [
      "sidebar",
      "widgets",
      "sections",
      "palette",
      "modes",
      "workspace.js",
      "customize",
    ],
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
    id: "voiceAssistant",
    label: "Assistant",
    category: "voice",
    keywords: ["assistant", "dock", "voice", "agent", "orchestrator", "talk"],
  },
  {
    id: "voiceId",
    label: "Default voice",
    category: "voice",
    keywords: ["voice", "speech", "speak", "read aloud", "tts", "sound"],
  },
  {
    id: "voiceMicrophone",
    label: "Microphone",
    category: "voice",
    keywords: ["microphone", "mic", "input", "audio", "device"],
  },
  {
    id: "voiceKeys",
    label: "Voice shortcuts in other apps",
    category: "voice",
    keywords: [
      "push to talk",
      "global",
      "other apps",
      "accessibility",
      "hold",
      "shortcut",
    ],
  },
  {
    id: "voiceDictation",
    label: "Dictation only",
    category: "voice",
    keywords: [
      "dictation",
      "dictate",
      "speech to text",
      "transcribe",
      "type with voice",
    ],
  },
  {
    id: "voiceInDock",
    label: "Show voice in dock",
    category: "voice",
    keywords: ["microphone", "dock", "hide", "show", "bubble"],
  },
  {
    id: "voiceBubbleSpot",
    label: "Floating microphone",
    category: "voice",
    keywords: ["microphone", "bubble", "position", "move", "left", "right"],
  },
  {
    id: "voiceInChats",
    label: "Show voice in chats",
    category: "voice",
    keywords: ["microphone", "composer", "chat", "hide", "show"],
  },
  {
    id: "voiceprint",
    label: "Only listen to me",
    category: "voice",
    keywords: ["voice print", "learn my voice", "other people", "background"],
  },
  {
    id: "github-cli",
    label: "GitHub CLI",
    category: "connections",
    keywords: ["github", "cli", "gh", "pull requests", "reviews", "account"],
  },
  {
    id: "connectors",
    label: "Connectors",
    category: "connections",
    keywords: ["connector", "mcp", "plugins", "tools", "servers"],
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
