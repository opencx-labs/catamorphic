"use client";

import {
  type AnimationEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Phase = "rest" | "leaving" | "arriving";

/** Each beat's keyframes (`@catamorphic/ui/styles.css`) and their length. */
const BEATS = {
  leaving: {
    animation: "catamorphic-swap-out",
    className: "cat-swap-out",
    ms: 200,
  },
  arriving: {
    animation: "catamorphic-swap-in",
    className: "cat-swap-in",
    ms: 200,
  },
} as const;

/**
 * How long past its animation a beat may wait for the animation's end. A
 * host without the keyframes (or a window that stopped painting) never
 * sends one; the text moves on anyway instead of freezing on old words.
 */
const BEAT_GRACE_MS = 250;

// Layout effects start a beat before the frame paints; servers skip them.
const useBeforePaint =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

interface Swap {
  /** What the element shows: the old text until it has left. */
  shown: string;
  phase: Phase;
  /** The beat's class, or none at rest. */
  beat: string;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * Text that changes on one beat: the old text fades away, then the new one
 * fades in. Changes that arrive mid-beat collapse into the latest, so a
 * burst reads as a few calm swaps rather than a flicker. The leaving beat
 * starts from the element's opacity where it is (`--cat-swap-from`), so a
 * line that was breathing never jumps back to full before it fades.
 */
function useSwap(value: string, element: RefObject<HTMLElement | null>): Swap {
  const [shown, setShown] = useState(value);
  const [phase, setPhase] = useState<Phase>("rest");
  const latest = useRef(value);
  latest.current = value;

  useBeforePaint(() => {
    if (phase !== "rest" || value === shown) return;
    const node = element.current;
    if (node) {
      const opacity = Number.parseFloat(getComputedStyle(node).opacity);
      node.style.setProperty(
        "--cat-swap-from",
        String(Number.isFinite(opacity) ? opacity : 1),
      );
    }
    setPhase("leaving");
  }, [value, shown, phase, element]);

  // Each beat ends on its animation's end; the timer is the fallback.
  const finish = (ended: Phase) => {
    if (ended === "leaving") {
      setShown(latest.current);
      setPhase("arriving");
    } else if (ended === "arriving") setPhase("rest");
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (phase === "rest") return;
    const timer = window.setTimeout(
      () => finishRef.current(phase),
      BEATS[phase].ms + BEAT_GRACE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  return {
    shown,
    phase,
    beat: phase === "rest" ? "" : BEATS[phase].className,
    // Each phase change swaps the animation class, which restarts it; the
    // swap happens on animationend, so it follows the motion (and still
    // fires under reduced motion, where every animation is near-instant).
    onAnimationEnd: (event) => {
      if (event.target !== event.currentTarget) return;
      if (phase !== "rest" && event.animationName === BEATS[phase].animation)
        finish(phase);
    },
  };
}

/**
 * The agent's live activity line: one line that never wraps, so its height
 * and what sits beside it never move. It breathes while the agent works,
 * and a new activity rides one strong beat of that pulse: the old text
 * fades all the way out from where its breath was, the new text fades in,
 * and the breathing resumes. First render is static.
 */
export function ActivityText({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const swap = useSwap(text, element);
  return (
    <span
      ref={element}
      data-testid="activity-text"
      data-phase={swap.phase === "rest" ? "breathing" : swap.phase}
      className={`block min-w-0 truncate ${swap.beat || "animate-pulse"} ${className}`}
      onAnimationEnd={swap.onAnimationEnd}
    >
      {swap.shown}
    </span>
  );
}

/**
 * A short label that changes in place (a step count, its word): the old
 * text fades out and the new one fades in, and the label's place widens or
 * narrows smoothly, so what follows it slides instead of jumping. While
 * the old text leaves, the place holds the wider of the two; it settles to
 * the new text's width as that arrives.
 */
export function SwapText({
  value,
  className = "",
  ...props
}: {
  value: string;
  className?: string;
  "data-testid"?: string;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const next = useRef<HTMLSpanElement>(null);
  const swap = useSwap(value, text);
  // At rest the place is the text's own width. Only a swap gives it a
  // width of its own, from where it was to where the text is going, which
  // the slot's transition plays; the place lets go once the swap is done.
  useBeforePaint(() => {
    const place = slot.current;
    if (!place) return;
    if (swap.phase === "rest") {
      if (place.style.width) place.style.width = "";
      return;
    }
    const at = place.getBoundingClientRect();
    // Not laid out (a hidden chat): the text keeps its own width.
    if (at.width === 0 && at.height === 0) {
      place.style.width = "";
      return;
    }
    const shownWidth = text.current?.getBoundingClientRect().width ?? 0;
    const nextWidth = next.current?.getBoundingClientRect().width ?? 0;
    const target =
      swap.phase === "leaving" ? Math.max(shownWidth, nextWidth) : shownWidth;
    if (!place.style.width) {
      place.style.width = `${at.width}px`;
      // Read back, so the start width is styled before the target is.
      place.getBoundingClientRect();
    }
    place.style.width = `${target}px`;
  }, [swap.phase, swap.shown, value]);
  return (
    <span {...props} ref={slot} className={`cat-swap-slot ${className}`}>
      {/* The coming text, measured but never read: its words are CSS
          content, so the label's text stays what it shows. */}
      <span
        ref={next}
        aria-hidden
        className="cat-swap-next"
        data-text={value}
      />
      <span
        ref={text}
        className={`cat-swap-text ${swap.beat}`}
        onAnimationEnd={swap.onAnimationEnd}
      >
        {swap.shown}
      </span>
    </span>
  );
}

/**
 * A value that stays for `ms` after it goes away, marked as leaving, so
 * what shows it can play its exit before it unmounts. A value that comes
 * back meanwhile simply stays. With `playing`, it stays on while its exit
 * still plays (see `afterMotion`).
 */
export function useLinger<T>(
  value: T | undefined,
  ms: number,
  playing?: () => boolean,
): { value: T | undefined; leaving: boolean } {
  const [kept, setKept] = useState(value);
  if (value !== undefined && value !== kept) setKept(value);
  const leaving = value === undefined && kept !== undefined;
  const exit = useRef(playing);
  exit.current = playing;
  useEffect(() => {
    if (!leaving) return;
    return afterMotion(
      ms,
      () => exit.current?.() ?? false,
      () => setKept(undefined),
    );
  }, [leaving, ms]);
  return { value: value ?? kept, leaving };
}

/** The longest a motion's end is waited for past its own length. */
const MOTION_WAIT_MS = 2_000;

/**
 * Calls `done` once `ms` have passed and `playing` no longer says the
 * motion it stands in for is under way. On a slow renderer a transition
 * starts with the first frame that styles it, which can come long after
 * the change: a timer alone would end it before it played, snapping what
 * it moves (a line that closes would drop its height in one frame).
 * Returns a cancel.
 */
export function afterMotion(
  ms: number,
  playing: () => boolean,
  done: () => void,
): () => void {
  const deadline = performance.now() + ms + MOTION_WAIT_MS;
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    if (playing() && performance.now() < deadline)
      timer = setTimeout(check, 50);
    else done();
  };
  timer = setTimeout(check, ms);
  return () => clearTimeout(timer);
}

/**
 * Whether `element` has a transition of `property` under way. Reading its
 * animations styles it first, so a transition the renderer has not yet
 * started starts here, and counts.
 */
export function transitionPlaying(
  element: Element | null | undefined,
  property: string,
): boolean {
  if (!element || typeof element.getAnimations !== "function") return false;
  return element
    .getAnimations()
    .some(
      (animation) =>
        "transitionProperty" in animation &&
        animation.transitionProperty === property &&
        animation.playState === "running",
    );
}
