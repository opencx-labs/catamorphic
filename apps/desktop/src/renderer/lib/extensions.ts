import { useCallback, useEffect, useState } from "react";
import type {
  ExtensionActionState,
  ExtensionsState,
} from "../../shared/extensions.js";
import { desktopApi } from "./desktop-api.js";

/**
 * Chrome extensions in the renderer (ADR 0203): the profile's installed
 * extensions and each tab's toolbar buttons, kept current from main.
 */

/** Asks a toolbar to open an extension's popup (main's `action.openPopup`). */
export const OPEN_EXTENSION_POPUP_EVENT = "catamorphic:extension-open-popup";

export interface OpenExtensionPopupDetail {
  extensionId: string;
  guestId: number | null;
  url: string;
}

export function useExtensionsState(enabled = true): {
  state: ExtensionsState | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<ExtensionsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await desktopApi.extensionsState());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return desktopApi.onExtensionsChanged(() => void refresh());
  }, [enabled, refresh]);
  return { state, error, refresh };
}

/** The toolbar buttons for the tab showing `guestId` (null: no page yet). */
export function useExtensionActions(
  guestId: number | null,
  enabled = true,
): ExtensionActionState[] {
  const [actions, setActions] = useState<ExtensionActionState[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      void desktopApi
        .extensionsActions({ guestId })
        .then((next) => {
          if (!cancelled) setActions(next);
        })
        .catch(() => {});
    load();
    const stop = desktopApi.onExtensionActionsChanged(load);
    return () => {
      cancelled = true;
      stop();
    };
  }, [guestId, enabled]);
  return actions;
}

/** Text that stays readable on a badge of `background` (CSS rgba). */
export function badgeTextColor(background: string): string {
  const match = /rgba?\(([^)]+)\)/.exec(background);
  const [r = 0, g = 0, b = 0] = (match?.[1] ?? "")
    .split(",")
    .map((part) => Number(part.trim()));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000" : "#fff";
}
