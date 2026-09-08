import { useEffect, useRef, useState } from "react";
import { desktopApi } from "./desktop-api.js";

/** Hover reveals the collapsed sidebar over the page without changing the
 * saved layout. Focus and sidebar menus keep it open while being used. */
export function useSidebarReveal(enabled: boolean) {
  const sidebarRef = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  const pointerInside = useRef(false);
  const nativePointerAvailable = useRef(false);

  useEffect(() => {
    if (
      revealed &&
      document.activeElement?.matches("[data-sidebar-reveal-edge]")
    ) {
      sidebarRef.current
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Expand sidebar"]',
        )
        ?.focus();
    }
  }, [revealed]);

  useEffect(() => {
    void desktopApi.windowSetControlsVisible(!enabled || revealed);
  }, [enabled, revealed]);

  useEffect(() => {
    return () => {
      void desktopApi.windowSetControlsVisible(true);
    };
  }, []);

  useEffect(() => {
    nativePointerAvailable.current = false;
    if (!enabled) {
      setRevealed(false);
      return;
    }
    const dismiss = () => {
      if (
        !pointerInside.current &&
        !sidebarRef.current?.contains(document.activeElement) &&
        !document.activeElement?.matches("[data-sidebar-reveal-edge]") &&
        !document.querySelector("[data-sidebar-menu]")
      ) {
        setRevealed(false);
      }
    };
    const trackPointer = (event: PointerEvent) => {
      if (nativePointerAvailable.current) return;
      const sidebar = sidebarRef.current;
      const bounds = sidebar?.firstElementChild?.getBoundingClientRect();
      if (!bounds) return;
      // While the overlay opens, Chromium can still target the webview
      // underneath it. Use the full-width sidebar body's geometry so that
      // stale guest entry events cannot immediately cancel the reveal.
      pointerInside.current =
        event.clientX >= bounds.left &&
        event.clientX < bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY < bounds.bottom;
      dismiss();
    };
    const hide = () => {
      pointerInside.current = false;
      setRevealed(false);
    };
    const unsubscribePointer = desktopApi.onSidebarPointerZone((zone) => {
      // Native coordinates stay correct when webviews retain stale hover
      // targets after an overlay transition or native window movement.
      nativePointerAvailable.current = true;
      pointerInside.current = zone !== "outside";
      if (zone === "edge") setRevealed(true);
      else if (zone === "outside") dismiss();
    });
    void desktopApi.windowSetSidebarEdgeEnabled(true);
    document.addEventListener("pointerover", trackPointer, true);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("blur", hide);
    return () => {
      unsubscribePointer();
      void desktopApi.windowSetSidebarEdgeEnabled(false);
      document.removeEventListener("pointerover", trackPointer, true);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("blur", hide);
    };
  }, [enabled]);

  return {
    sidebarRef,
    revealed: enabled && revealed,
    reveal: () => setRevealed(true),
    revealOnHover: () => {
      if (!nativePointerAvailable.current) setRevealed(true);
    },
  };
}
