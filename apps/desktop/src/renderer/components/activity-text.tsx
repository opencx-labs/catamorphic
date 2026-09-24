import { useEffect, useRef, useState } from "react";

type Phase = "breathing" | "leaving" | "arriving";

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

  // Each phase change swaps the animation class, which restarts it; the
  // swap happens on animationend, so it follows the motion (and still
  // fires under reduced motion, where every animation is near-instant).
  return (
    <span
      data-testid="activity-text"
      data-phase={phase}
      className={`${
        phase === "leaving"
          ? "animate-activity-leave"
          : phase === "arriving"
            ? "animate-activity-arrive"
            : "animate-pulse"
      } ${className}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "activity-leave") {
          setShown(latestRef.current);
          setPhase("arriving");
        } else if (event.animationName === "activity-arrive") {
          setPhase("breathing");
        }
      }}
    >
      {shown}
    </span>
  );
}
