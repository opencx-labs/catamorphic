import { type RefObject, useEffect } from "react";
import { EASE_STANDARD, motionMs } from "./motion.js";

/**
 * Classes for the frame: it clips what has not glided into view yet. Clip,
 * not hidden: a hidden frame is still a scroll container, and Chromium
 * scrolled it to show the caret on a new line, so the first line jumped up
 * and slid back while the frame grew. Its 150ms is {@link GLIDE_MS}.
 */
export const GLIDING_FRAME =
  "overflow-clip transition-[height] duration-150 ease-standard";

/** The frame's glide, which the text's own glide keeps pace with. */
export const GLIDE_MS = 150;

/** Nothing follows the caret: it is where the draft ends. */
function caretAtEnd(input: HTMLElement): boolean {
  if (input instanceof HTMLTextAreaElement)
    return input.selectionEnd === input.value.length;
  const selection = input.ownerDocument.getSelection();
  if (!selection?.focusNode || !input.contains(selection.focusNode))
    return false;
  const rest = input.ownerDocument.createRange();
  rest.setStart(selection.focusNode, selection.focusOffset);
  rest.setEnd(input, input.childNodes.length);
  // A pill after the caret reads as its label: not the end.
  return rest.toString().replace(/\u200B/g, "") === "";
}

/**
 * Size changes glide instead of snapping: a frame around an auto-height
 * input tweens to the input's measured height (Shift+Enter, wrapping,
 * recall of a longer draft, growth while typing). The input keeps its own
 * max-height and overflow for scrolling; the frame just follows it via
 * ResizeObserver. The chat composer and the palette's input grow alike.
 *
 * A draft taller than the input scrolls inside it, and an edit that
 * shortens it (Backspace on its last line, a cut, an undo) lets the
 * browser pull the scroll back to the shorter end in the same frame: the
 * text dropped a line at once, and dropped part of one where the draft
 * came back under the input's height, while the frame around it glided.
 * The text is drawn where it was and glides down instead, on the frame's
 * curve, so a line leaving moves as a line arriving does at every height.
 * Editing at the draft's end keeps its end in view: emptying the last
 * line, Chromium left the scroll short of it, so the text dropped and the
 * caret's line was cut off with nothing shorter about the draft.
 * The whole draft glides, as the frame moves it under the input's height:
 * a line deleted mid-draft lets the lines below it ride back down. Only
 * that pull counts: the person's own scrolling, the caret being revealed
 * and a draft replaced in place (recall, clearing) keep theirs.
 */
export function useGlidingHeight({
  content,
  frame,
  scroller = content,
}: {
  content: RefObject<HTMLElement | null>;
  frame: RefObject<HTMLElement | null>;
  /**
   * The element that scrolls, inside `content`, when it is not `content`
   * itself: the palette's textarea, mounted only in the modes that type
   * plain text. Its events are read where they pass through `content`.
   */
  scroller?: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    const measured = content.current;
    const target = frame.current;
    if (!measured || !target) return;
    const follow = () => {
      const height = `${measured.offsetHeight}px`;
      if (target.style.height !== height) target.style.height = height;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(measured);
    // Where the text was scrolled before the edit: every scroll reports it
    // by the next frame, and an edit lands between frames.
    const scrolled = new WeakMap<EventTarget, number>();
    // Only the input's own events: the chat composer inside the palette
    // glides its text itself.
    const scrolling = (event: Event) => {
      const source = scroller.current;
      return source !== null && event.target === source ? source : null;
    };
    const onScroll = (event: Event) => {
      const source = scrolling(event);
      if (source) scrolled.set(source, source.scrollTop);
    };
    const onInput = (event: Event) => {
      const source = scrolling(event);
      if (!source) return;
      let now = source.scrollTop;
      const before = scrolled.get(source) ?? now;
      const end = source.scrollHeight - source.clientHeight;
      // Emptying the last line, Chromium lays the draft out for a moment
      // without it and keeps the scroll that layout allowed: the text
      // dropped part of a line and the caret's line was cut off, though
      // the draft is as tall as before. Editing at its end, the draft
      // shows its end: the scroll goes back to where it was, never past
      // the shorter end, as the caret's own reveal would put it.
      const kept = Math.min(before, end);
      if (now < kept - 0.5 && caretAtEnd(source)) {
        source.scrollTo({ top: kept, behavior: "instant" });
        now = source.scrollTop;
      }
      const drop = before - now;
      scrolled.set(source, now);
      const duration = motionMs(GLIDE_MS);
      if (drop < 0.5 || !duration) return;
      // Pulled back by the shorter draft: left at its new end. A scroll
      // the edit asked for (revealing a caret above) stops short of it.
      if (now < end - 1) return;
      // A cut of more than the input shows kept nothing in view: the text
      // comes down from one input's height above, as a scroll back would.
      const offset = Math.min(drop, source.clientHeight);
      // Added to any glide still running, so quick edits sum, never jump.
      source.animate(
        [
          { transform: `translateY(${-offset}px)` },
          { transform: "translateY(0)" },
        ],
        { duration, easing: EASE_STANDARD, composite: "add" },
      );
    };
    // Scrolls do not bubble: caught on their way down.
    measured.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    measured.addEventListener("input", onInput);
    return () => {
      observer.disconnect();
      measured.removeEventListener("scroll", onScroll, { capture: true });
      measured.removeEventListener("input", onInput);
    };
  }, [content, frame, scroller]);
}
