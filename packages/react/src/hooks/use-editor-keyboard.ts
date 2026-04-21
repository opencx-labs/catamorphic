"use client";

import { useAtom } from "jotai";
import { useEffect } from "react";
import { historySidebarOpenAtom, rightPanelOpenAtom } from "../atoms.js";

/**
 * Document-level keyboard handling for the workflow editor. Owns the Escape
 * behaviour: first close the history sidebar if it is open, otherwise close
 * the detail panel. Split out of `WorkflowEditor` so hosts building their
 * own chrome can keep the same UX without re-implementing the logic.
 */
export function useEditorKeyboard(): void {
  const [historySidebarOpen, setHistorySidebarOpen] = useAtom(
    historySidebarOpenAtom,
  );
  const [rightPanelOpen, setRightPanelOpen] = useAtom(rightPanelOpenAtom);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (historySidebarOpen) {
        setHistorySidebarOpen(false);
      } else if (rightPanelOpen) {
        setRightPanelOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    historySidebarOpen,
    setHistorySidebarOpen,
    rightPanelOpen,
    setRightPanelOpen,
  ]);
}
