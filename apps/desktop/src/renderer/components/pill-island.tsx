import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Each wing either side of the cutout: one control's room. */
export const ISLAND_WING = 44;
/** The open row under the cutout: the strip's bubbles. */
export const ISLAND_ROW = 44;
/** The pointer dwells this long before the island opens, and away this long before it closes. */
const OPEN_DWELL_MS = 120;
const CLOSE_DWELL_MS = 320;

/**
 * The island's outline: concave flares where it meets the top of the
 * screen, so it reads as the notch grown down, and rounded lower corners
 * (Companion's notch path). `body` is the width between the flares.
 * Every state draws the same commands, so CSS can morph one into another.
 */
export function islandPath(input: {
  /** The SVG's width; the island is centred in it. */
  canvas: number;
  body: number;
  height: number;
  flare: number;
  radius: number;
}): string {
  const f = 0.5523;
  const k = 0.72;
  const { flare: rt, height: h } = input;
  const rb = Math.min(input.radius, h / 2, input.body / 2);
  const l = (input.canvas - input.body) / 2 - rt;
  const r = (input.canvas + input.body) / 2 + rt;
  const bl = l + rt;
  const br = r - rt;
  const n = (value: number) => Math.round(value * 100) / 100;
  return [
    `M${n(l)},0`,
    `C${n(l + f * rt)},0 ${n(bl)},${n(rt - f * rt)} ${n(bl)},${n(rt)}`,
    `L${n(bl)},${n(h - rb)}`,
    `C${n(bl)},${n(h - rb + k * rb)} ${n(bl + rb - k * rb)},${n(h)} ${n(bl + rb)},${n(h)}`,
    `L${n(br - rb)},${n(h)}`,
    `C${n(br - rb + k * rb)},${n(h)} ${n(br)},${n(h - rb + k * rb)} ${n(br)},${n(h - rb)}`,
    `L${n(br)},${n(rt)}`,
    `C${n(br)},${n(rt - f * rt)} ${n(r - f * rt)},0 ${n(r)},0`,
    "Z",
  ].join(" ");
}

/**
 * The pill at the notch (ADR 0242): a black island that wraps the camera
 * cutout, the microphone in one wing and the chats' bubble in the other.
 * It opens downward into the strip when the pointer reaches it, when the
 * person opens it, or while a chat is open, morphing its one outline; the
 * row's controls fade in once it has room. On black the theme's surface
 * tokens become light ones (styles.css, `.pill-island`), so the strip's
 * own controls draw on it unchanged.
 */
export function PillIsland({
  notch,
  open,
  hoverOpens,
  hovered,
  onHoverChange,
  leftWing,
  rightWing,
  row,
}: {
  notch: { width: number; height: number };
  /** Opened by the person or by an open chat, not only by hover. */
  open: boolean;
  hoverOpens: boolean;
  hovered: boolean;
  onHoverChange: (hovered: boolean) => void;
  leftWing: ReactNode;
  rightWing: ReactNode;
  /** The strip's row, under the cutout. */
  row: ReactNode;
}) {
  const shown = open || (hoverOpens && hovered);
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const measure = () => setRowWidth(element.scrollWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hover = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => onHoverChange(next),
      next ? OPEN_DWELL_MS : CLOSE_DWELL_MS,
    );
  };
  const rest = notch.width + 2 * ISLAND_WING;
  const wide = Math.max(rest, rowWidth + 28);
  const body = shown ? wide : rest;
  const height = shown ? notch.height + ISLAND_ROW + 12 : notch.height;
  const flare = shown ? 10 : 7;
  const canvas = wide + 2 * 10;
  const tallest = notch.height + ISLAND_ROW + 12;
  const d = islandPath({
    canvas,
    body,
    height,
    flare,
    radius: shown ? 22 : Math.min(12, notch.height / 2),
  });
  return (
    <div
      data-pill-island={shown ? "open" : "rest"}
      // Its box is the island's: the window lets clicks through outside
      // it, and the pointer leaving it is the pointer leaving the island.
      className="pill-island pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2 animate-island-arrive transition-[width,height] duration-[420ms] ease-[var(--ease-island)]"
      style={{ width: body + 2 * flare, height }}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      onFocusCapture={() => onHoverChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          hover(false);
      }}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 overflow-visible"
        width={canvas}
        height={tallest}
        viewBox={`0 0 ${canvas} ${tallest}`}
      >
        <path
          data-island-shape
          className="transition-[d] duration-[420ms] ease-[var(--ease-island)]"
          style={{ d: `path("${d}")` }}
          fill="#000"
        />
      </svg>
      <div
        className="absolute top-0 flex items-center justify-center"
        style={{
          left: `calc(50% - ${notch.width / 2 + ISLAND_WING}px)`,
          width: ISLAND_WING,
          height: notch.height,
        }}
        data-island-wing="left"
      >
        {leftWing}
      </div>
      <div
        className="absolute top-0 flex items-center justify-center"
        style={{
          left: `calc(50% + ${notch.width / 2}px)`,
          width: ISLAND_WING,
          height: notch.height,
        }}
        data-island-wing="right"
      >
        {rightWing}
      </div>
      <div
        ref={rowRef}
        data-island-row
        aria-hidden={!shown}
        inert={!shown ? true : undefined}
        className={`absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 transition-[opacity,translate] ease-[cubic-bezier(0.2,0,0,1)] ${
          shown
            ? "translate-y-0 opacity-100 delay-[120ms] duration-200"
            : "pointer-events-none -translate-y-1 opacity-0 duration-100"
        }`}
        style={{ top: notch.height + 6, height: ISLAND_ROW }}
      >
        {row}
      </div>
    </div>
  );
}
