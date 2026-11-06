import { type RefObject, useEffect } from "react";

/**
 * Classes for the frame: it clips what has not glided into view yet. Clip,
 * not hidden: a hidden frame is still a scroll container, and Chromium
 * scrolled it to show the caret on a new line, so the first line jumped up
 * and slid back while the frame grew.
 */
export const GLIDING_FRAME =
  "overflow-clip transition-[height] duration-150 ease-standard";

/**
 * Size changes glide instead of snapping: a frame around an auto-height
 * input tweens to the input's measured height (Shift+Enter, wrapping,
 * recall of a longer draft, growth while typing). The input keeps its own
 * max-height and overflow for scrolling; the frame just follows it via
 * ResizeObserver. The chat composer and the palette's input grow alike.
 */
export function useGlidingHeight({
  content,
  frame,
}: {
  content: RefObject<HTMLElement | null>;
  frame: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    const source = content.current;
    const target = frame.current;
    if (!source || !target) return;
    const follow = () => {
      const height = `${source.offsetHeight}px`;
      if (target.style.height !== height) target.style.height = height;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(source);
    return () => observer.disconnect();
  }, [content, frame]);
}
