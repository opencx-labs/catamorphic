"use client";

import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { selectedNodeIdAtom } from "../atoms.js";

/**
 * Document-level Escape handling for the workflow editor. Inspectors follow
 * the selected step, so Escape clears the selection. `onEscape` runs first
 * and returns true when it consumed the key (for example, closing a Runs
 * pane). Keys typed into fields and code editors are left to them.
 */
export function useEditorKeyboard({
  onEscape,
}: {
  onEscape?: () => boolean;
} = {}): void {
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
  const handleEscape = useRef(onEscape);
  handleEscape.current = onEscape;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      )
        return;
      if (handleEscape.current?.()) return;
      setSelectedNodeId(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setSelectedNodeId]);
}
