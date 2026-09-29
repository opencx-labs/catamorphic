import { useMemo, useRef } from "react";
import type { HistoryEntry } from "../../../shared/history.js";
import { usePaletteHost } from "../host.js";
import type {
  PaletteChoiceMode,
  PaletteItem,
  PaletteMode,
  PaletteModeRequest,
} from "../types.js";
import { useChoiceModes } from "./choices.js";
import { customPaletteModes } from "./custom.js";
import { useFileModes } from "./files.js";
import { useHistoryMode } from "./history.js";
import { useInputModes } from "./input.js";
import { commandsMode, settingsMode } from "./lists.js";
import { sectionMode } from "./section.js";
import { useSitesMode } from "./sites.js";

/**
 * Every mode the palette offers (ADR 0186), in @-list order. A new built-in
 * mode is one file in this folder and one entry here: its chip, its typed
 * names (from BUILTIN_PALETTE_TRIGGERS) and where its rows come from.
 */
export function usePaletteModes({
  picker,
  historyRow,
  settingItems,
  commandItems,
  sectionSearch,
}: {
  picker: PaletteChoiceMode | null;
  historyRow: (entry: HistoryEntry) => PaletteItem;
  settingItems: readonly PaletteItem[];
  commandItems: readonly PaletteItem[];
  sectionSearch: Extract<PaletteModeRequest, { mode: "section" }> | null;
}) {
  const {
    workspaceConfig,
    projectId,
    memberShell = false,
    onOpenUrl,
    onError,
  } = usePaletteHost();
  const choices = useChoiceModes({ picker });
  const history = useHistoryMode(historyRow);
  const files = useFileModes();
  const sites = useSitesMode();
  const input = useInputModes({ projectAgents: choices.projectAgents });
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const customModes = useMemo(
    () =>
      customPaletteModes({
        config: workspaceConfig,
        projectId,
        memberShell,
        onOpenUrl,
        onError: (message) => errorRef.current?.(message),
      }),
    [workspaceConfig, projectId, memberShell, onOpenUrl],
  );
  const modes = useMemo<PaletteMode[]>(
    () => [
      history,
      ...files,
      settingsMode(settingItems),
      sites,
      commandsMode(commandItems),
      ...choices.modes,
      ...input,
      ...customModes,
      ...(sectionSearch ? [sectionMode(sectionSearch)] : []),
    ],
    [
      history,
      files,
      settingItems,
      sites,
      commandItems,
      choices.modes,
      input,
      customModes,
      sectionSearch,
    ],
  );
  return { modes, customModes };
}
