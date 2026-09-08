/** Resource-opening intent shared by the shell and webview preload (ADR 0108). */
export type OpenMode = "replace" | "tab" | "side" | "floating";

export interface OpenModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function openModeFromEvent(
  event: OpenModifiers,
  fallback: OpenMode = "replace",
  mac = /Mac/.test(navigator.platform),
): OpenMode {
  const primary = mac ? event.metaKey : event.ctrlKey;
  if (primary) return event.shiftKey ? "side" : "tab";
  if (event.altKey) return "floating";
  return fallback;
}

export const OPEN_ACTIONS = [
  { label: "Open here", action: "open-here", mode: "replace" },
  { label: "Open in new tab", action: "open-tab", mode: "tab" },
  { label: "Open to the side", action: "open-side", mode: "side" },
  { label: "Open floating", action: "open-floating", mode: "floating" },
] as const;

export function openModeForAction(action: string): OpenMode | undefined {
  return OPEN_ACTIONS.find((entry) => entry.action === action)?.mode;
}
