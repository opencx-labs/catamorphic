import { useEffect, useRef } from "react";

/** The thumb never shrinks below this, however long the list. */
const MIN_THUMB = 28;
/** How long the thumb stays after the last scroll. */
const IDLE_MS = 900;
/** How near the outer edge the pointer brings the thumb out. */
const EDGE_PX = 14;

/** Whether `element` scrolls vertically and has somewhere to go. */
function scrolls(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.scrollHeight - element.clientHeight <= 1) return false;
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll";
}

/**
 * Where an area's lists are scrolled to, shown only while it helps. The
 * area's scrollers hide their own scrollbars (styles.css); one thin thumb
 * on the area's outer edge (the window's edge, for a sidebar) stands in for
 * whichever of them is moving: the one that scrolled last, or the one
 * beside the pointer as it nears that edge. It spans that list's own height
 * (a section's list inside the sidebar, or the whole sidebar), fades in,
 * can be dragged, and fades out once nothing needs it. It takes no room, so
 * nothing is narrowed or shifted, and at rest nothing shows. The lists stay
 * the things that scroll: wheel, keyboard and find all still move them.
 */
export function OverlayScrollbar({
  getArea,
  edge,
}: {
  /** The positioned element holding the scrollers; the thumb rests in it. */
  getArea: () => HTMLElement | null;
  edge: "left" | "right";
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const area = useRef(getArea);
  area.current = getArea;

  useEffect(() => {
    const box = area.current();
    const bar = track.current;
    const handle = thumb.current;
    if (!box || !bar || !handle) return;
    let active: HTMLElement | null = null;
    let idle: number | undefined;
    let near = false;
    let drag: { pointerId: number; y: number; scrollTop: number } | null = null;

    /** Places the track over the active list and the thumb in it. */
    const place = () => {
      if (!active?.isConnected || !scrolls(active)) {
        bar.dataset.shown = "false";
        return false;
      }
      const outer = box.getBoundingClientRect();
      const inner = active.getBoundingClientRect();
      const top = Math.max(inner.top, outer.top) - outer.top + 4;
      const bottom = Math.min(inner.bottom, outer.bottom) - outer.top - 4;
      const height = bottom - top;
      if (height < MIN_THUMB) {
        bar.dataset.shown = "false";
        return false;
      }
      bar.style.top = `${top}px`;
      bar.style.height = `${height}px`;
      const range = active.scrollHeight - active.clientHeight;
      const size = Math.max(
        MIN_THUMB,
        (height * active.clientHeight) / active.scrollHeight,
      );
      handle.style.height = `${size}px`;
      handle.style.transform = `translateY(${Math.round((active.scrollTop / range) * (height - size))}px)`;
      return true;
    };
    const settle = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (!near && !drag) bar.dataset.shown = "false";
      }, IDLE_MS);
    };
    const show = (list: HTMLElement) => {
      if (drag) return;
      active = list;
      if (!place()) return;
      bar.dataset.shown = "true";
      settle();
    };
    const onScroll = (event: Event) => {
      if (drag) {
        place();
        return;
      }
      if (event.target instanceof HTMLElement && box.contains(event.target))
        show(event.target);
    };
    /** The innermost list beside height `y`, or none. */
    const listAt = (y: number) => {
      let found: HTMLElement | null = null;
      for (const element of [box, ...box.querySelectorAll("*")]) {
        if (!scrolls(element) || !element.checkVisibility()) continue;
        const rect = element.getBoundingClientRect();
        if (y < rect.top || y > rect.bottom) continue;
        if (!found || found.contains(element)) found = element;
      }
      return found;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (drag) return;
      const outer = box.getBoundingClientRect();
      const reach =
        edge === "left"
          ? event.clientX - outer.left
          : outer.right - event.clientX;
      const list =
        reach >= 0 && reach <= EDGE_PX ? listAt(event.clientY) : null;
      if (list) {
        near = true;
        if (list !== active || bar.dataset.shown !== "true") show(list);
      } else if (near) {
        near = false;
        settle();
      }
    };
    const onPointerLeave = () => {
      near = false;
      settle();
    };
    const onThumbDown = (event: PointerEvent) => {
      if (event.button !== 0 || !active) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      drag = {
        pointerId: event.pointerId,
        y: event.clientY,
        scrollTop: active.scrollTop,
      };
      bar.dataset.dragging = "true";
    };
    const onThumbMove = (event: PointerEvent) => {
      if (!drag || !active || event.pointerId !== drag.pointerId) return;
      const travel = bar.clientHeight - handle.offsetHeight;
      if (travel <= 0) return;
      active.scrollTop =
        drag.scrollTop +
        ((event.clientY - drag.y) *
          (active.scrollHeight - active.clientHeight)) /
          travel;
    };
    const onThumbUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      delete bar.dataset.dragging;
      settle();
    };
    // The thumb sits over the list's edge: a wheel there still scrolls it.
    const onThumbWheel = (event: WheelEvent) => {
      event.preventDefault();
      active?.scrollBy({ top: event.deltaY, left: 0 });
    };
    // A list that grows or shrinks while the thumb shows keeps it right.
    const resize = new ResizeObserver(() => {
      if (bar.dataset.shown === "true") place();
    });
    resize.observe(box);

    const listen = new AbortController();
    const { signal } = listen;
    box.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
      signal,
    });
    box.addEventListener("pointermove", onPointerMove, { signal });
    box.addEventListener("pointerleave", onPointerLeave, { signal });
    handle.addEventListener("pointerdown", onThumbDown, { signal });
    handle.addEventListener("pointermove", onThumbMove, { signal });
    handle.addEventListener("pointerup", onThumbUp, { signal });
    handle.addEventListener("pointercancel", onThumbUp, { signal });
    handle.addEventListener("wheel", onThumbWheel, { passive: false, signal });
    return () => {
      listen.abort();
      window.clearTimeout(idle);
      resize.disconnect();
    };
  }, [edge]);

  return (
    <div
      ref={track}
      aria-hidden="true"
      className="overlay-scrollbar"
      data-edge={edge}
      data-shown="false"
    >
      <div ref={thumb} className="overlay-scrollbar-thumb" />
    </div>
  );
}
