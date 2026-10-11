"use client";

import { useEffect, useRef, useState } from "react";

type Phase = "breathing" | "leaving" | "arriving";

/** Each beat's keyframes (`@catamorphic/ui/styles.css`) and their length. */
const BEATS = {
  leaving: { animation: "catamorphic-activity-leave", ms: 150 },
  arriving: { animation: "catamorphic-activity-arrive", ms: 200 },
} as const;

/**
 * How long past its animation a beat may wait for the animation's end. A
 * host without the keyframes (or a window that stopped painting) never
 * sends one; the line moves on anyway instead of freezing on old text.
 */
const BEAT_GRACE_MS = 250;

/**
 * The agent's live activity line. It breathes while the agent works, and a
 * new activity rides one beat of that pulse: the old text fades out, the
 * new text fades in, and the breathing resumes. Activities that arrive
 * mid-beat collapse into the latest one, so a burst of tool calls reads as
 * a few calm swaps rather than a flicker. First render is static.
 */
export function ActivityText({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<Phase>("breathing");
  const latestRef = useRef(text);
  latestRef.current = text;

  useEffect(() => {
    if (phase === "breathing" && text !== shown) setPhase("leaving");
  }, [text, shown, phase]);

  // Each beat ends on its animation's end; the timer is the fallback.
  const finish = (ended: Phase) => {
    if (ended === "leaving") {
      setShown(latestRef.current);
      setPhase("arriving");
    } else if (ended === "arriving") setPhase("breathing");
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (phase === "breathing") return;
    const timer = window.setTimeout(
      () => finishRef.current(phase),
      BEATS[phase].ms + BEAT_GRACE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Each phase change swaps the animation class, which restarts it; the
  // swap happens on animationend, so it follows the motion (and still
  // fires under reduced motion, where every animation is near-instant).
  return (
    <span
      data-testid="activity-text"
      data-phase={phase}
      className={`${
        phase === "leaving"
          ? "cat-activity-leave"
          : phase === "arriving"
            ? "cat-activity-arrive"
            : "animate-pulse"
      } ${className}`}
      onAnimationEnd={(event) => {
        if (
          phase !== "breathing" &&
          event.animationName === BEATS[phase].animation
        )
          finish(phase);
      }}
    >
      {shown}
    </span>
  );
}
