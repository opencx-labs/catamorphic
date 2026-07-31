import { useEffect, useRef, useState } from "react";

/**
 * Truncating label that plays an attention pulse when its text changes:
 * the new text slides in while the accent color briefly flashes, so a
 * renamed chat is noticeable without being loud. First render is static.
 */
export function AnimatedTitle({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const prevTextRef = useRef(text);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (prevTextRef.current === text) return;
    prevTextRef.current = text;
    setChanged(true);
  }, [text]);

  // The class is removed on animationend, so a later rename re-adds it and
  // the animation replays (class toggling restarts CSS animations).
  return (
    <span
      className={`truncate ${changed ? "animate-title-change" : ""} ${className}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "title-change") setChanged(false);
      }}
    >
      {text}
    </span>
  );
}
