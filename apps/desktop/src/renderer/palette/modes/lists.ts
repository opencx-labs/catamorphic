import { Command, PanelTop, Settings as SettingsIcon } from "lucide-react";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** Only settings; Enter opens and highlights the control. */
export const settingsMode = (items: readonly PaletteItem[]): PaletteMode => ({
  id: "settings",
  chip: "Settings",
  icon: SettingsIcon,
  label: "Search settings",
  description: "Find a setting and open its control",
  placeholder: "Search settings…",
  names: BUILTIN_PALETTE_TRIGGERS.settings,
  rows: { kind: "list", items },
});

/** Only commands; ">" at the start of the input filters to the same rows. */
export const commandsMode = (items: readonly PaletteItem[]): PaletteMode => ({
  id: "commands",
  chip: "Commands",
  icon: Command,
  label: "Search commands",
  description: "Only commands, skills, projects and profiles",
  placeholder: "Search commands…",
  names: BUILTIN_PALETTE_TRIGGERS.commands,
  rows: { kind: "list", items },
});

/** Open tabs in strip order; Enter switches to one. */
export const tabsMode = (items: readonly PaletteItem[]): PaletteMode => ({
  id: "tabs",
  chip: "Tabs",
  icon: PanelTop,
  label: "Search open tabs",
  description: "Switch to a tab you have open",
  placeholder: "Search open tabs…",
  names: BUILTIN_PALETTE_TRIGGERS.tabs,
  rows: { kind: "list", items },
});
