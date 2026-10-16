import { useEffect, useRef } from "react";

/**
 * Agent pointers: the agent directing the user's attention. Any element
 * carrying `data-point-key` is addressable (workspace tabs by tab key,
 * in the strip or as a sidebar list's rows, other sidebar items as
 * "sidebar:<label>", app rows as "app:<name>"); a
 * pointed element gets a soft accent glow (`.agent-pointer` in
 * styles.css), scrolls into view, and optionally shows the agent's short
 * note. The glow fades in (`animate-agent-pointer-in`), holds steady
 * until the user interacts with the element (pointerdown/focus) or the
 * agent points elsewhere, and fades out the way it came
 * (`animate-agent-pointer-out`) before its marks come off.
 *
 * The pointed elements are React's: a re-render that rewrites one's
 * className (a tab turning active, a row selected) takes the glow's
 * classes with it. A glowing element puts them back at once, steady
 * (`agent-pointer-held`), so the ring neither vanishes nor fades in again;
 * a fading one resumes its fade where the rewrite cut it (a press on a
 * pointed tab dismisses its glow, then the click makes it active).
 */

/**
 * Where a target is drawn: the first match the person can see, or the
 * first at all (a sidebar row and a strip tab may share a tab key).
 */
export function pointedElement(
  target: string,
  root: ParentNode = document,
): Element | null {
  const matches = [
    ...root.querySelectorAll(`[data-point-key="${CSS.escape(target)}"]`),
  ];
  return (
    matches.find(
      (element) =>
        typeof element.checkVisibility !== "function" ||
        element.checkVisibility(),
    ) ??
    matches[0] ??
    null
  );
}

export interface AgentPointer {
  target: string;
  note?: string;
}

const ENTER = "animate-agent-pointer-in";
const HELD = "agent-pointer-held";
const LEAVE = "animate-agent-pointer-out";
/** Beyond the 200ms exit: hidden windows can skip animationend. */
const LEAVE_FALLBACK_MS = 400;

/** The ring is showing: entering, or held after a class rewrite. */
const showing = (element: HTMLElement) =>
  element.classList.contains("agent-pointer") &&
  (element.classList.contains(ENTER) || element.classList.contains(HELD));

function light(element: HTMLElement, steady: boolean) {
  element.classList.remove(LEAVE);
  element.classList.add("agent-pointer", steady ? HELD : ENTER);
}

/** Puts back what a className rewrite took off a glowing element. */
function hold(element: HTMLElement) {
  if (!showing(element)) element.classList.add("agent-pointer", HELD);
}

/** Elements fading out, with when their fade began. */
type Fading = Map<HTMLElement, number>;

function unlight(element: HTMLElement, fading: Fading) {
  const done = () => {
    element.removeEventListener("animationend", ended);
    fading.delete(element);
    element.style.removeProperty("--agent-pointer-elapsed");
    // Pointed at again meanwhile: the glow stays.
    if (element.classList.contains(ENTER) || element.classList.contains(HELD))
      return;
    element.classList.remove("agent-pointer", LEAVE);
    element.removeAttribute("data-agent-pointer-note");
  };
  const ended = (event: AnimationEvent) => {
    if (event.target === element && event.animationName === "agent-pointer-out")
      done();
  };
  // Only a ring on screen fades: one a rewrite already took goes quietly.
  const visible = showing(element);
  element.classList.remove(ENTER, HELD);
  if (!visible) {
    done();
    return;
  }
  element.classList.add(LEAVE);
  fading.set(element, performance.now());
  element.addEventListener("animationend", ended);
  window.setTimeout(done, LEAVE_FALLBACK_MS);
}

/** Puts a fade a className rewrite took back, as far along as it was. */
function resume(element: HTMLElement, fading: Fading) {
  const began = fading.get(element);
  if (began === undefined || element.classList.contains(LEAVE)) return;
  element.style.setProperty(
    "--agent-pointer-elapsed",
    `${Math.round(began - performance.now())}ms`,
  );
  element.classList.add("agent-pointer", LEAVE);
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
  const fading = useRef<Fading>(new Map());
  // Rewrites outside a workspace change (a row selected) put the glow
  // back too, before the frame paints.
  const watcher = useRef<MutationObserver | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-resolves pointers after tab mounts
  useEffect(() => {
    const wanted = new Map<HTMLElement, AgentPointer>();
    for (const pointer of pointers) {
      const element = pointedElement(pointer.target);
      if (element instanceof HTMLElement) wanted.set(element, pointer);
    }
    // Targets already glowing: a new element for one (a remount) takes the
    // ring steady instead of fading in again.
    const glowing = new Set([...lit.current.values()].map((x) => x.target));
    for (const [element, entry] of lit.current) {
      if (wanted.get(element)?.target === entry.target) continue;
      entry.detach();
      lit.current.delete(element);
      if (!wanted.has(element)) unlight(element, fading.current);
    }
    // Newest pointer last in state → reversed here so it wins the scroll.
    let scrolled = false;
    for (const [element, pointer] of [...wanted].reverse()) {
      if (pointer.note) {
        element.setAttribute("data-agent-pointer-note", pointer.note);
      } else {
        element.removeAttribute("data-agent-pointer-note");
      }
      if (lit.current.has(element)) {
        hold(element);
        continue;
      }
      light(element, glowing.has(pointer.target));
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
    watcher.current ??= new MutationObserver((records) => {
      for (const { target } of records) {
        if (!(target instanceof HTMLElement)) continue;
        if (lit.current.has(target)) hold(target);
        else resume(target, fading.current);
      }
    });
    watcher.current.disconnect();
    for (const element of [...lit.current.keys(), ...fading.current.keys()])
      watcher.current.observe(element, {
        attributes: true,
        attributeFilter: ["class"],
      });
  }, [pointers, revision]);

  // Unmounted with the workspace: nothing is left to fade into.
  useEffect(() => {
    const glowing = lit.current;
    const leaving = fading.current;
    return () => {
      watcher.current?.disconnect();
      for (const element of leaving.keys())
        element.style.removeProperty("--agent-pointer-elapsed");
      leaving.clear();
      for (const [element, entry] of glowing) {
        entry.detach();
        element.classList.remove("agent-pointer", ENTER, HELD, LEAVE);
        element.removeAttribute("data-agent-pointer-note");
      }
      glowing.clear();
    };
  }, []);

  return null;
}
