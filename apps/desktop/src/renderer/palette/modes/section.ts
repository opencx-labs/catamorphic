import { Search } from "lucide-react";
import type { PaletteMode, PaletteModeRequest } from "../types.js";

/** A sidebar section's search: its own rows, loaded once per request. */
export const sectionMode = (
  request: Extract<PaletteModeRequest, { mode: "section" }>,
): PaletteMode => ({
  id: "section",
  chip: request.label,
  icon: Search,
  placeholder: `Search ${request.label.toLowerCase()}…`,
  rows: {
    kind: "load",
    key: request.nonce,
    filtered: false,
    load: async (_query, signal) => ({ items: await request.load(signal) }),
  },
});
