import { type AppPrefs, normalizePrefs } from "./app-prefs.js";
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
    description: "Show this profile's project chats together in the dock.",
    scopes: profileScope,
    valid: boolean,
  },
  dockDetached: {
    label: "Detached chat dock",
    description: "Keep the dock above other windows and desktops.",
    scopes: profileScope,
    valid: boolean,
  },
  dockSide: {
    label: "Dock position",
    description: "You can also drag the dock handle to either side.",
    scopes: profileScope,
    valid: oneOf("left", "right"),
    options: { left: "Left", right: "Right" },
  },
  tabPlacement: {
    label: "Open tabs",
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
  tabFrame: {
    label: "Tab frame",
    scopes: projectScopes,
    valid: boolean,
    description: "Add a rounded, inset border around tab content.",
  },
  pinnedBookmarks: {
    label: "Pinned bookmarks",
    scopes: projectScopes,
    valid: oneOf("tiles", "list"),
    options: { tiles: "Icon tiles", list: "List" },
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
      description?: string;
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
