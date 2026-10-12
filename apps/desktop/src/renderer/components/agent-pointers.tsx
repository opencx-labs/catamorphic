import { useEffect, useRef } from "react";

/**
 * Agent pointers: the agent directing the user's attention. Any element
 * carrying `data-point-key` is addressable (workspace tabs by tab key,
 * sidebar items as "sidebar:<label>", app rows as "app:<name>"); a
 * pointed element gets a soft accent glow (`.agent-pointer` in
 * styles.css), scrolls into view, and optionally shows the agent's short
 * note. The glow fades in (`animate-agent-pointer-in`), holds steady
 * until the user interacts with the element (pointerdown/focus) or the
 * agent points elsewhere, and fades out the way it came
 * (`animate-agent-pointer-out`) before its marks come off.
 */

export interface AgentPointer {
  target: string;
  note?: string;
}

const ENTER = "animate-agent-pointer-in";
const LEAVE = "animate-agent-pointer-out";
/** Beyond the 200ms exit: hidden windows can skip animationend. */
const LEAVE_FALLBACK_MS = 400;

function light(element: HTMLElement) {
  element.classList.remove(LEAVE);
  element.classList.add("agent-pointer", ENTER);
}

function unlight(element: HTMLElement) {
  element.classList.remove(ENTER);
  element.classList.add(LEAVE);
  const done = () => {
    element.removeEventListener("animationend", ended);
    // Pointed at again meanwhile: the glow stays.
    if (!element.classList.contains(LEAVE)) return;
    element.classList.remove("agent-pointer", LEAVE);
    element.removeAttribute("data-agent-pointer-note");
  };
  const ended = (event: AnimationEvent) => {
    if (event.target === element && event.animationName === "agent-pointer-out")
      done();
  };
  element.addEventListener("animationend", ended);
  window.setTimeout(done, LEAVE_FALLBACK_MS);
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
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  /** Elements glowing now, with the target they glow for. */
  const lit = useRef(
    new Map<HTMLElement, { target: string; detach: () => void }>(),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-resolves pointers after tab mounts
  useEffect(() => {
    const wanted = new Map<HTMLElement, AgentPointer>();
    for (const pointer of pointers) {
      const element = document.querySelector(
        `[data-point-key="${CSS.escape(pointer.target)}"]`,
      );
      if (element instanceof HTMLElement) wanted.set(element, pointer);
    }
    for (const [element, entry] of lit.current) {
      if (wanted.get(element)?.target === entry.target) continue;
      entry.detach();
      lit.current.delete(element);
      if (!wanted.has(element)) unlight(element);
    }
    // Newest pointer last in state → reversed here so it wins the scroll.
    let scrolled = false;
    for (const [element, pointer] of [...wanted].reverse()) {
      if (pointer.note) {
        element.setAttribute("data-agent-pointer-note", pointer.note);
      } else {
        element.removeAttribute("data-agent-pointer-note");
      }
      if (lit.current.has(element)) continue;
      light(element);
      const dismiss = () => onDismissRef.current(pointer.target);
      element.addEventListener("pointerdown", dismiss);
      element.addEventListener("focusin", dismiss);
      lit.current.set(element, {
        target: pointer.target,
        detach: () => {
          element.removeEventListener("pointerdown", dismiss);
          element.removeEventListener("focusin", dismiss);
        },
      });
      if (!scrolled) {
        // One scroll per update: the newest pointer to light wins attention.
        scrolled = true;
        element.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
      }
    }
  }, [pointers, revision]);

  // Unmounted with the workspace: nothing is left to fade into.
  useEffect(() => {
    const glowing = lit.current;
    return () => {
      for (const [element, entry] of glowing) {
        entry.detach();
        element.classList.remove("agent-pointer", ENTER, LEAVE);
        element.removeAttribute("data-agent-pointer-note");
      }
      glowing.clear();
    };
  }, []);

  return null;
}
