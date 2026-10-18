import { useEffect, useRef } from "react";

/** The thumb never shrinks below this, however long the list. */
const MIN_THUMB = 28;
/** How long the thumb stays after the last scroll. */
const IDLE_MS = 900;
/** How near the outer edge the pointer brings the thumbs out: both lanes. */
const EDGE_PX = 16;

/**
 * Which list a thumb stands for, and so its lane from the sidebar's outer
 * edge in (ADR 0248): the sidebar's own panel on the edge itself, and a
 * section's list that asks for a thumb (`scrollbar: true`) one lane in,
 * in padding the panel widens for it. Nested lists, nested lanes: the two
 * never overlap, and neither lies over a row.
 */
export type ScrollLane = "panel" | "section";

/** Whether `element` is a list this lane's thumb stands for. */
function belongs(element: HTMLElement, lane: ScrollLane): boolean {
  const panel = element.classList.contains("sidebar-tab-panel");
  if (lane === "panel") return panel;
  return !panel && element.closest("[data-sidebar-scrollbar]") !== null;
}

/** Whether `element` scrolls vertically, has somewhere to go, and is `lane`'s. */
function scrolls(element: Element, lane: ScrollLane): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.scrollHeight - element.clientHeight <= 1) return false;
  if (!belongs(element, lane)) return false;
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll";
}

/**
 * Where a sidebar list is scrolled to (ADR 0248). The sidebar's lists hide
 * their own scrollbars (styles.css) and fade the edge they continue past
 * (`cat-edge-fade`); one thin thumb per lane stands in for them. The panel
 * lane's stands for the sidebar's own panel; the section lane's for
 * whichever list that asked for a thumb is moving: the one that scrolled
 * last, or the one beside the pointer as it nears the outer edge. A thumb
 * spans its list's own height, fades in, can be dragged, and fades out once
 * nothing needs it. The panel's thumb takes no room; a section's takes
 * the 8px of outer padding its sidebar adds for it. At rest nothing
 * shows. The lists stay the things that scroll: wheel, keyboard and find
 * all still move them.
 */
export function OverlayScrollbar({
  getArea,
  edge,
  lane,
}: {
  /** The positioned element holding the scrollers; the thumb rests in it. */
  getArea: () => HTMLElement | null;
  edge: "left" | "right";
  lane: ScrollLane;
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
      if (!active?.isConnected || !scrolls(active, lane)) {
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
    // The list the thumb stands for, and what it holds, as they change
    // size (a section opening, rows arriving) while the thumb shows.
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (bar.dataset.shown === "true") place();
          });
    resize?.observe(box);
    const follow = (list: HTMLElement) => {
      if (!resize) return;
      resize.disconnect();
      resize.observe(box);
      resize.observe(list);
      for (const child of list.children) resize.observe(child);
    };
    const show = (list: HTMLElement) => {
      if (drag) return;
      if (list !== active) follow(list);
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
      // A list holding the shown one scrolled (the panel, under a
      // section's list): the track follows its list.
      if (
        active &&
        bar.dataset.shown === "true" &&
        event.target instanceof Node &&
        event.target !== active &&
        event.target.contains(active)
      ) {
        place();
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        box.contains(event.target) &&
        scrolls(event.target, lane)
      )
        show(event.target);
    };
    // The lane's lists that can scroll, read once as the pointer reaches
    // the edge and kept while it stays there.
    let lists: HTMLElement[] | null = null;
    /** The innermost of the lane's lists beside height `y`, or none. */
    const listAt = (y: number) => {
      lists ??= [
        ...box.querySelectorAll(
          lane === "panel"
            ? ".sidebar-tab-panel"
            : "[data-sidebar-scrollbar], [data-sidebar-scrollbar] *",
        ),
      ].filter(
        (element): element is HTMLElement =>
          scrolls(element, lane) && element.checkVisibility(),
      );
      let found: HTMLElement | null = null;
      for (const list of lists) {
        const rect = list.getBoundingClientRect();
        if (y < rect.top || y > rect.bottom) continue;
        if (!found || found.contains(list)) found = list;
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
      const atEdge = reach >= 0 && reach <= EDGE_PX;
      if (!atEdge) lists = null;
      const list = atEdge ? listAt(event.clientY) : null;
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
      lists = null;
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
    handle.addEventListener("lostpointercapture", onThumbUp, { signal });
    handle.addEventListener("wheel", onThumbWheel, { passive: false, signal });
    return () => {
      listen.abort();
      window.clearTimeout(idle);
      resize?.disconnect();
    };
  }, [edge, lane]);

  return (
    <div
      ref={track}
      aria-hidden="true"
      className="overlay-scrollbar"
      data-edge={edge}
      data-lane={lane}
      data-shown="false"
    >
      <div ref={thumb} className="overlay-scrollbar-thumb" />
    </div>
  );
}
