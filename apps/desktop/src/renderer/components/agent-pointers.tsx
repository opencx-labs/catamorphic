import { useEffect } from "react";

/**
 * Agent pointers: the agent directing the user's attention. Any element
 * carrying `data-point-key` is addressable (workspace tabs by tab key,
 * sidebar items as "sidebar:<label>", app rows as "app:<name>"); a
 * pointed element gets a soft accent glow (`.agent-pointer` in
 * styles.css), scrolls into view, and optionally shows the agent's short
 * note. The glow is a waiting state — it pulses gently until the user
 * interacts with the element (pointerdown/focus) or the agent points
 * elsewhere, mirroring the waiting-question pulse's sanctioned loop.
 */

export interface AgentPointer {
  target: string;
  note?: string;
}

export function AgentPointers({
  pointers,
  onDismiss,
  /** Any changing value that may have (un)mounted pointable elements. */
  revision,
}: {
  pointers: AgentPointer[];
  onDismiss: (target: string) => void;
  revision: unknown;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-resolves pointers after tab mounts
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    let scrolled = false;
    // Newest pointer last in state → reversed here so it wins the scroll.
    for (const pointer of [...pointers].reverse()) {
      const element = document.querySelector(
        `[data-point-key="${CSS.escape(pointer.target)}"]`,
      );
      if (!(element instanceof HTMLElement)) continue;
      element.classList.add("agent-pointer");
      if (pointer.note) {
        element.setAttribute("data-agent-pointer-note", pointer.note);
      }
      if (!scrolled) {
        // One scroll per update — the newest pointer wins attention.
        scrolled = true;
        element.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
      }
      const dismiss = () => onDismiss(pointer.target);
      element.addEventListener("pointerdown", dismiss);
      element.addEventListener("focusin", dismiss);
      cleanups.push(() => {
        element.classList.remove("agent-pointer");
        element.removeAttribute("data-agent-pointer-note");
        element.removeEventListener("pointerdown", dismiss);
        element.removeEventListener("focusin", dismiss);
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [pointers, onDismiss, revision]);

  return null;
}
