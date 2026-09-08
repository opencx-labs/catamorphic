import fs from "node:fs";
import path from "node:path";
import {
  normalizeTerminalMacros,
  type TerminalMacro,
} from "../shared/terminal-macros.js";

/**
 * Per-profile app preferences, stored as plain JSON at
 * `profiles/<id>/prefs.json` — same philosophy as keybindings.json: user-
 * and agent-editable, file-watched, applies live. Grows one flat key per
 * preference; unknown keys are preserved on save so future versions (or
 * outside tools) can add keys without this build eating them.
 */
export interface AppPrefs {
  /** Soft chime when an agent finishes or asks a question. */
  notificationSounds: boolean;
  /** OS notification for the same events while the app is unfocused. */
  desktopNotifications: boolean;
  /** Whether the left sidebar is shown. */
  sidebarOpen: boolean;
  /** Workspace tabs can live above the content or in the sidebar. */
  tabPlacement: "top" | "sidebar";
  headerPlacement: "top" | "sidebar";
  /** Profile-wide favorites can be compact tiles or labeled rows. */
  pinnedBookmarks: "tiles" | "list";
  linkOpenMode: "tab" | "floating";
  previewLinksWithAlt: boolean;
  terminalMacros: TerminalMacro[];
  terminalAppearance: "app" | "ghostty";
  rightSidebarOpen: boolean;
  /** The project the profile last worked in — where a relaunch lands. */
  lastProjectId?: string;
  /** Sessions this profile has explicitly or implicitly marked unread. */
  unreadSessionIds: string[];
}

export const DEFAULT_PREFS: AppPrefs = {
  notificationSounds: true,
  desktopNotifications: true,
  sidebarOpen: true,
  tabPlacement: "top",
  headerPlacement: "top",
  pinnedBookmarks: "tiles",
  linkOpenMode: "tab",
  previewLinksWithAlt: true,
  terminalMacros: [],
  terminalAppearance: "app",
  rightSidebarOpen: true,
  unreadSessionIds: [],
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ];
}

export function normalizePrefs(raw: unknown): AppPrefs {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    notificationSounds:
      typeof record.notificationSounds === "boolean"
        ? record.notificationSounds
        : DEFAULT_PREFS.notificationSounds,
    desktopNotifications:
      typeof record.desktopNotifications === "boolean"
        ? record.desktopNotifications
        : DEFAULT_PREFS.desktopNotifications,
    rightSidebarOpen:
      typeof record.rightSidebarOpen === "boolean"
        ? record.rightSidebarOpen
        : DEFAULT_PREFS.rightSidebarOpen,
    sidebarOpen:
      typeof record.sidebarOpen === "boolean"
        ? record.sidebarOpen
        : DEFAULT_PREFS.sidebarOpen,
    tabPlacement: record.tabPlacement === "sidebar" ? "sidebar" : "top",
    headerPlacement: record.headerPlacement === "sidebar" ? "sidebar" : "top",
    pinnedBookmarks: record.pinnedBookmarks === "list" ? "list" : "tiles",
    terminalAppearance:
      record.terminalAppearance === "ghostty" ? "ghostty" : "app",
    linkOpenMode: record.linkOpenMode === "floating" ? "floating" : "tab",
    previewLinksWithAlt:
      typeof record.previewLinksWithAlt === "boolean"
        ? record.previewLinksWithAlt
        : true,
    terminalMacros: normalizeTerminalMacros(record.terminalMacros),
    ...(typeof record.lastProjectId === "string"
      ? { lastProjectId: record.lastProjectId }
      : {}),
    unreadSessionIds: stringList(record.unreadSessionIds),
  };
}

export class PrefsStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  load(): AppPrefs {
    try {
      return normalizePrefs(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch {
      return normalizePrefs({});
    }
  }

  save(prefs: Partial<AppPrefs>): AppPrefs {
    // Preserve unknown keys: read the raw file, overlay known prefs.
    let raw: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (typeof parsed === "object" && parsed !== null) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing/corrupt file: start fresh.
    }
    const next = normalizePrefs({ ...raw, ...prefs });
    fs.writeFileSync(
      this.file,
      `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`,
    );
    return next;
  }

  /** Watch the containing dir (editors replace files by rename). */
  watch(onChange: (prefs: AppPrefs) => void): void {
    const dir = path.dirname(this.file);
    const name = path.basename(this.file);
    this.watcher = fs.watch(dir, (_event, changed) => {
      if (changed !== name) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => onChange(this.load()), 100);
    });
  }

  dispose(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
  }
}
