import { Command, Settings as SettingsIcon } from "lucide-react";
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
