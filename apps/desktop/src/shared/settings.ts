import {
  type AppPrefs,
  BROWSER_TAB_SLEEP,
  CODE_THEMES,
  normalizePrefs,
} from "./app-prefs.js";
import { normalizeTerminalMacros } from "./terminal-macros.js";

export type SettingsScope = "profile" | "project" | "personal";
export type SettingSource = "default" | SettingsScope;
const boolean = (value: unknown) => typeof value === "boolean";
const oneOf =
  (...values: string[]) =>
  (value: unknown) =>
    typeof value === "string" && values.includes(value);
const projectScopes: readonly SettingsScope[] = [
  "profile",
  "project",
  "personal",
];
const profileScope: readonly SettingsScope[] = ["profile"];

/** User choices only. Sidebar pose, last project and unread ids are runtime state. */
export const SETTINGS = {
  dockMultiProject: {
    label: "Chats from all projects",
    description: "Show this profile's project chats together in the pill.",
    scopes: profileScope,
    valid: boolean,
  },
  dockDetached: {
    label: "Pill on the desktop",
    description:
      "Float the pill in a window of its own, above every app and on every desktop, also while Work is minimized.",
    scopes: profileScope,
    valid: boolean,
  },
  dockEdge: {
    label: "Screen edge",
    description:
      "Where the pill docks on the desktop. Drag it to any edge, the notch included.",
    scopes: profileScope,
    valid: oneOf("bottom", "left", "right", "top"),
    options: {
      bottom: "Bottom",
      left: "Left",
      right: "Right",
      top: "Top, at the notch",
    },
  },
  dockFollowsWindow: {
    label: "Rest in the Work window",
    description:
      "At the bottom of the screen, the pill sits in the front Work window's chat area while Work is in front.",
    scopes: profileScope,
    valid: boolean,
  },
  dockIslandHover: {
    label: "Open at the notch on hover",
    description:
      "At the notch, the pill opens into its chats when the pointer reaches it.",
    scopes: profileScope,
    valid: boolean,
    macOnly: true,
  },
  dockSide: {
    label: "Folded pill corner",
    description:
      "The bottom corner the folded pill rests in. Drag it to the other one.",
    scopes: profileScope,
    valid: oneOf("left", "right"),
    options: { left: "Left", right: "Right" },
  },
  dockPlacement: {
    label: "Open chat position",
    description:
      "Where open chats and their bubbles sit at the bottom. Drag the arrows button to move them.",
    scopes: profileScope,
    valid: oneOf("left", "center", "right"),
    options: { left: "Left", center: "Centered", right: "Right" },
  },
  chatWorkLive: {
    label: "While the agent works",
    description:
      'Notes are what the agent writes between its steps (tool calls and commands). Steps list open under each note as they run. "Notes only" keeps them folded into a line you can open, a single step too, while the agent works and after. "Latest note and steps" moves earlier notes into the steps of the newest one.',
    scopes: profileScope,
    valid: oneOf("all", "latest", "notes"),
    options: {
      all: "Notes and steps",
      latest: "Latest note and steps",
      notes: "Notes only",
    },
  },
  chatWorkSettled: {
    label: "Once it has answered",
    description:
      'Steps fold into a line you can open either way (a single step stays in view unless "Notes only" is on). "Fold notes into steps" moves the notes into that line too.',
    scopes: profileScope,
    valid: oneOf("keep", "collapse"),
    options: { keep: "Keep the notes", collapse: "Fold notes into steps" },
  },
  chatQueueMessages: {
    label: "Queue messages sent while the agent works",
    description:
      "Off: the agent reads your message at its next step, and Interrupt on your message has the agent read it at once. On: your message waits until the agent finishes, and you can edit it until then.",
    scopes: profileScope,
    valid: boolean,
  },
  windowButtons: {
    label: "Window buttons",
    description:
      "Close, minimize and full screen at the top left of the window. While they are hidden, the menu bar still has each of them.",
    scopes: profileScope,
    valid: boolean,
    macOnly: true,
  },
  sidebarDividers: {
    label: "Sidebar dividers",
    description: "Show a vertical separator beside each sidebar.",
    scopes: projectScopes,
    valid: boolean,
  },
  contentFrame: {
    label: "Framed content",
    description:
      "Inset the workspace as a rounded, bordered window. Padding and corner radius apply while it is on.",
    scopes: projectScopes,
    valid: boolean,
  },
  contentPadding: {
    label: "Frame padding",
    description: "Space around the framed workspace in pixels.",
    scopes: projectScopes,
    range: { min: 0, max: 48, step: 1 },
    valid: (value: unknown) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 48,
  },
  contentRadius: {
    label: "Frame corner radius",
    description:
      "Round the framed workspace corners in pixels. Use 0 for square corners.",
    scopes: projectScopes,
    range: { min: 0, max: 48, step: 1 },
    valid: (value: unknown) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 48,
  },
  tabAlignment: {
    label: "Tab alignment",
    scopes: projectScopes,
    valid: oneOf("start", "center"),
    options: { start: "Left", center: "Centered" },
  },
  tabPlacement: {
    label: "Open tabs",
    description:
      "In the sidebar, its Tabs section lists them; a sidebar without one keeps them in the top bar.",
    scopes: projectScopes,
    valid: oneOf("top", "sidebar"),
    options: { top: "Top bar", sidebar: "Sidebar" },
  },
  headerPlacement: {
    label: "Title and address bar",
    description: "Applies when open tabs are in the sidebar.",
    scopes: projectScopes,
    valid: oneOf("top", "sidebar"),
    options: { top: "Above content", sidebar: "In sidebar" },
  },
  linkOpenMode: {
    label: "Links requesting a new window",
    scopes: projectScopes,
    valid: oneOf("tab", "floating"),
    options: { tab: "New tab", floating: "Floating preview" },
  },
  previewLinksWithAlt: {
    label: "Alt-click web links to preview",
    scopes: projectScopes,
    valid: boolean,
  },
  switchToOpenTab: {
    label: "Switch to a page's open tab",
    description:
      "Opening a page that is already open, from a link, a bookmark or another app, goes to its tab. Opening it in a new tab on purpose still does.",
    scopes: profileScope,
    valid: boolean,
  },
  browserTabSleep: {
    label: "Sleep unused tabs",
    description:
      "Pages you have not looked at for a while unload to free memory and load again when you return, keeping your place. Tabs playing sound, using the camera, microphone or screen, holding typed text, or being worked by an agent stay awake.",
    scopes: profileScope,
    valid: oneOf(...BROWSER_TAB_SLEEP),
    options: {
      "15m": "After 15 minutes",
      "30m": "After 30 minutes",
      "1h": "After 1 hour",
      "2h": "After 2 hours",
      never: "Never",
    },
  },
  notificationSounds: {
    label: "Notification sounds",
    scopes: profileScope,
    valid: boolean,
  },
  desktopNotifications: {
    label: "Desktop notifications",
    scopes: profileScope,
    valid: boolean,
  },
  codeTheme: {
    label: "Code and diff theme",
    scopes: profileScope,
    valid: oneOf(...CODE_THEMES),
    options: {
      github: "GitHub",
      catppuccin: "Catppuccin",
      "rose-pine": "Rose Pine",
      one: "One",
      solarized: "Solarized",
      vitesse: "Vitesse",
    },
  },
  diffLayout: {
    label: "Diff layout",
    scopes: profileScope,
    valid: oneOf("split", "unified"),
    options: { split: "Side by side", unified: "Unified" },
  },
  diffWrap: {
    label: "Wrap diff lines",
    scopes: profileScope,
    valid: boolean,
  },
  reviewStartView: {
    label: "Open reviews in",
    scopes: profileScope,
    valid: oneOf("overview", "guide", "diff"),
    options: { overview: "Overview", guide: "Guide", diff: "Changes" },
  },
  reviewGrouping: {
    label: "Review guide grouping",
    scopes: profileScope,
    valid: oneOf("purpose", "directory", "flat"),
    options: { purpose: "Purpose", directory: "Directory", flat: "All files" },
  },
  terminalAppearance: {
    label: "Terminal appearance",
    scopes: profileScope,
    valid: oneOf("app", "ghostty"),
    options: { app: "App theme", ghostty: "Ghostty configuration" },
  },
  terminalMacros: {
    label: "Terminal shortcuts",
    scopes: profileScope,
    valid: (value: unknown) => {
      if (!Array.isArray(value)) return false;
      const normalized = normalizeTerminalMacros(value);
      return (
        normalized.length === value.length &&
        value.every(
          (item: unknown, index) =>
            item !== null &&
            typeof item === "object" &&
            "shortcut" in item &&
            normalized[index]?.shortcut === item.shortcut,
        )
      );
    },
  },
} satisfies Partial<
  Record<
    keyof AppPrefs,
    {
      label: string;
      scopes: readonly SettingsScope[];
      valid: (value: unknown) => boolean;
      options?: Record<string, string>;
      range?: { min: number; max: number; step: number };
      description?: string;
      /** Only macOS has it; Settings and the palette offer it nowhere else. */
      macOnly?: boolean;
    }
  >
>;
export type SettingKey = keyof typeof SETTINGS;
export type SettingsValues = Pick<AppPrefs, SettingKey>;
export type SettingsPatch = { [K in SettingKey]?: SettingsValues[K] | null };
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const WORKSPACE_SETTING_KEYS = SETTING_KEYS.filter((key) =>
  SETTINGS[key].scopes.includes("project"),
);
export const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
  default: "App default",
  profile: "Profile",
  project: "Project",
  personal: "Just for me",
};
export interface SettingsSnapshot {
  values: AppPrefs;
  sources: Record<SettingKey, SettingSource>;
  overrides: Partial<SettingsValues>;
  scope: SettingsScope;
  projectAvailable: boolean;
  errors: string[];
}

export function settingsLayer(
  raw: unknown,
  scope: SettingsScope,
): Partial<SettingsValues> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    SETTING_KEYS.flatMap((key) => {
      const value = Reflect.get(raw, key);
      return SETTINGS[key].scopes.includes(scope) && SETTINGS[key].valid(value)
        ? [[key, normalizePrefs({ [key]: value })[key]]]
        : [];
    }),
  );
}

/** Per-key precedence. Missing and invalid keys inherit; false is an override. */
export function resolveSettings({
  profile,
  project,
  personal,
  scope = "personal",
  projectAvailable = false,
  errors = [],
}: {
  profile: unknown;
  project?: unknown;
  personal?: unknown;
  scope?: SettingsScope;
  projectAvailable?: boolean;
  errors?: string[];
}): SettingsSnapshot {
  const layers = {
    profile: settingsLayer(profile, "profile"),
    project: settingsLayer(project, "project"),
    personal: settingsLayer(personal, "personal"),
  };
  const order: SettingsScope[] =
    scope === "profile"
      ? ["profile"]
      : scope === "project"
        ? ["profile", "project"]
        : ["profile", "project", "personal"];
  const values = normalizePrefs(profile);
  const defaults = normalizePrefs({});
  const sources = Object.fromEntries(
    SETTING_KEYS.map((key) => [key, "default"]),
  ) as Record<SettingKey, SettingSource>;
  for (const key of SETTING_KEYS) {
    Reflect.set(values, key, defaults[key]);
    for (const layer of order)
      if (Object.hasOwn(layers[layer], key)) {
        Reflect.set(values, key, layers[layer][key]);
        sources[key] = layer;
      }
  }
  return {
    values,
    sources,
    overrides: layers[scope],
    scope,
    projectAvailable,
    errors,
  };
}

/** Validate authored keys before a file becomes the active layer. */
export function validateSettingsLayer(
  raw: Record<string, unknown>,
  scope: SettingsScope,
): void {
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const definition = SETTINGS[key];
    if (!definition.scopes.includes(scope))
      throw new Error(`${definition.label} is a profile setting`);
    if (!definition.valid(raw[key]))
      throw new Error(`Invalid value for ${definition.label}`);
  }
}
