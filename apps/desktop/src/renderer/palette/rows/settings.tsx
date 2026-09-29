import { Settings as SettingsIcon } from "lucide-react";
import { useMemo } from "react";
import { SETTINGS_CATALOG } from "../../../shared/settings-catalog.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem } from "../types.js";

/** One row per setting; Enter opens and highlights its control. */
export function useSettingRows() {
  const { onOpenTab } = usePaletteHost();
  const settingItems = useMemo<PaletteItem[]>(
    () =>
      SETTINGS_CATALOG.map((setting) => ({
        id: `setting:${setting.id}`,
        label: setting.label,
        detail: `Settings · ${setting.category}`,
        icon: SettingsIcon,
        keywords: [
          "settings",
          "preferences",
          setting.category,
          ...setting.keywords,
        ],
        kind: "navigate",
        category: "setting",
        usage: `setting:${setting.id}`,
        run: (mode) =>
          onOpenTab(
            {
              kind: "settings",
              name: "settings",
              label: "Settings",
              destination: { id: setting.id, requestId: crypto.randomUUID() },
            },
            mode,
          ),
      })),
    [onOpenTab],
  );
  return settingItems;
}
