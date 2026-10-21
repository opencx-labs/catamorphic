import { SETTING_KEYS, type SettingKey } from "./settings.js";
import { type SettingsCategory, settingCategory } from "./settings-catalog.js";

/**
 * What one profile can take from another (ADR 0272): the Settings categories
 * that hold look and feel. Agents, connections, passwords, voice, history and
 * browsing data always stay with their own profile.
 */
export const PROFILE_SYNC_PARTS = [
  "appearance",
  "workspace",
  "macros",
  "shortcuts",
  "notifications",
] as const satisfies readonly SettingsCategory[];
export type ProfileSyncPart = (typeof PROFILE_SYNC_PARTS)[number];

/**
 * Part → the profile whose files hold it. A profile follows that owner for
 * the part; owners have no entry of their own, so every follower names the
 * owner directly.
 */
export type ProfileSync = Partial<Record<ProfileSyncPart, string>>;

export const PROFILE_SYNC_LABELS: Record<
  ProfileSyncPart,
  { label: string; detail: string }
> = {
  appearance: {
    label: "Appearance",
    detail: "Theme, colors, fonts and code theme",
  },
  workspace: {
    label: "Workspace",
    detail: "Layout, tabs, sidebars, palette, dock and code review",
  },
  macros: { label: "Macros", detail: "Your terminal commands" },
  shortcuts: { label: "Keyboard shortcuts", detail: "Every key binding" },
  notifications: { label: "Notifications", detail: "Sounds and alerts" },
};

/** Whole files in a profile folder that belong to one part. */
export const PROFILE_SYNC_FILES: Record<ProfileSyncPart, readonly string[]> = {
  appearance: ["theme.json"],
  workspace: ["workspace.js"],
  macros: [],
  shortcuts: ["keybindings.json"],
  notifications: [],
};

const keysIn = (part: ProfileSyncPart): readonly SettingKey[] =>
  SETTING_KEYS.filter((key) => settingCategory(key) === part);

/** The preferences in prefs.json that belong to one part: its Settings category. */
export const PROFILE_SYNC_KEYS: Record<ProfileSyncPart, readonly SettingKey[]> =
  {
    appearance: keysIn("appearance"),
    workspace: keysIn("workspace"),
    macros: keysIn("macros"),
    shortcuts: keysIn("shortcuts"),
    notifications: keysIn("notifications"),
  };

export function isProfileSyncPart(value: unknown): value is ProfileSyncPart {
  return PROFILE_SYNC_PARTS.some((part) => part === value);
}
