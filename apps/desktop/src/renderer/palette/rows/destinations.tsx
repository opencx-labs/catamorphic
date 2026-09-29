import {
  ChartColumn,
  Download,
  History,
  KeyRound,
  Settings2,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo } from "react";
import { surfaceUsageKey } from "../../../shared/palette.js";
import { formatBinding, useKeybindings } from "../../lib/keybindings.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem } from "../types.js";

/**
 * The app's own surfaces (Settings, Usage, History, Sites, Downloads,
 * Passwords) and the focused site's settings. Surfaces count a visit
 * however they are opened (ADR 0186).
 */
export function useDestinationRows() {
  const {
    profileId,
    onOpenTab,
    focusedSite = null,
    onOpenSiteSettings,
  } = usePaletteHost();
  const keybindings = useKeybindings();
  const surfaceItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    items.push({
      id: "tab:settings",
      icon: SettingsIcon,
      label: "Settings",
      detail: "Open settings",
      keywords: [
        "settings",
        "preferences",
        "configuration",
        "shortcuts",
        "theme",
        "keys",
      ],
      shortcut: formatBinding(keybindings["open-settings"]),
      kind: "navigate",
      category: "surface",
      usage: surfaceUsageKey("settings"),
      run: (mode) =>
        onOpenTab(
          { kind: "settings", name: "settings", label: "Settings" },
          mode,
        ),
    });
    items.push({
      id: "tab:usage",
      icon: ChartColumn,
      label: "Usage",
      detail: "Tokens and cost across agents",
      keywords: ["usage", "cost", "tokens", "spend", "billing", "consumption"],
      kind: "navigate",
      category: "surface",
      usage: surfaceUsageKey("usage"),
      run: (mode) =>
        onOpenTab({ kind: "usage", name: "usage", label: "Usage" }, mode),
    });

    if (focusedSite && onOpenSiteSettings) {
      const { origin, host } = focusedSite;
      items.push({
        id: "site-settings",
        icon: Settings2,
        label: "Site settings",
        // The host is where it applies, not what it is: typing a site's
        // name should find its pages first.
        detail: host,
        keywords: [
          "site",
          "permissions",
          "camera",
          "microphone",
          "location",
          "notifications",
          "cookies",
        ],
        kind: "action",
        category: "command",
        usage: "site-settings",
        run: () => onOpenSiteSettings(origin),
      });
    }
    if (profileId)
      items.push({
        id: "open-passwords",
        icon: KeyRound,
        label: "Passwords",
        detail: "Saved logins and notes",
        keywords: ["passwords", "logins", "credentials", "keychain", "notes"],
        kind: "navigate",
        category: "surface",
        usage: surfaceUsageKey("passwords"),
        run: (mode) =>
          onOpenTab(
            { kind: "passwords", name: profileId, label: "Passwords" },
            mode,
          ),
      });
    items.push({
      id: "open-downloads",
      icon: Download,
      label: "Downloads",
      detail: "Files saved from pages",
      keywords: ["downloads", "files", "saved", "download"],
      kind: "navigate",
      category: "surface",
      usage: surfaceUsageKey("downloads"),
      run: (mode) =>
        onOpenTab(
          { kind: "downloads", name: "downloads", label: "Downloads" },
          mode,
        ),
    });
    items.push({
      id: "open-sites",
      icon: SlidersHorizontal,
      label: "Sites",
      detail: "Permissions and data per site",
      keywords: ["sites", "permissions", "cookies", "site settings", "data"],
      kind: "navigate",
      category: "surface",
      usage: surfaceUsageKey("sites"),
      run: (mode) =>
        onOpenTab({ kind: "sites", name: "sites", label: "Sites" }, mode),
    });
    return items;
  }, [focusedSite, onOpenSiteSettings, onOpenTab, profileId, keybindings]);
  const historyPageItem = useMemo<PaletteItem>(
    () => ({
      id: "open-history",
      icon: History,
      label: "History",
      detail: "Pages and work you've opened",
      keywords: ["history", "recent", "visited"],
      kind: "navigate",
      category: "surface",
      usage: surfaceUsageKey("history"),
      run: (mode) =>
        onOpenTab({ kind: "history", name: "history", label: "History" }, mode),
    }),
    [onOpenTab],
  );

  return { surfaceItems, historyPageItem };
}
