import type { SidebarTrend } from "../../shared/sidebar.js";
import { TONE_TEXT } from "../lib/tones.js";

const WIDTH = 36;
const HEIGHT = 14;
/** Readings a line has room for: a short history starts at the right. */
const SLOTS = 30;

/** The line and the area under it, latest reading at the right edge. */
export function sparklinePaths(values: readonly number[]): {
  line: string;
  area: string;
} {
  if (values.length === 0) return { line: "", area: "" };
  const step = WIDTH / (Math.max(values.length, SLOTS) - 1);
  const start = WIDTH - step * (values.length - 1);
  // A hairline stays visible at zero; the top keeps the stroke inside.
  const y = (value: number) =>
    HEIGHT - 1 - Math.max(0, Math.min(1, value)) * (HEIGHT - 2);
  const points = values.map(
    (value, index) =>
      `${(start + step * index).toFixed(2)},${y(value).toFixed(2)}`,
  );
  const line = `M${points.join("L")}`;
  return {
    line,
    area: `${line}L${WIDTH},${HEIGHT}L${start.toFixed(2)},${HEIGHT}Z`,
  };
}

/**
 * A row's trend (ADR 0266): a reading's recent history as a small line and
 * area in the accent (or its tone), with the current reading beside it.
 */
export function Sparkline({ trend }: { trend: SidebarTrend }) {
  const { line, area } = sparklinePaths(trend.values);
  return (
    <span
      data-trend
      className={`flex shrink-0 items-center gap-1.5 ${trend.tone ? TONE_TEXT[trend.tone] : "text-accent"}`}
    >
      <svg
        aria-hidden="true"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="overflow-visible"
      >
        <path d={area} fill="currentColor" fillOpacity={0.16} />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {trend.label !== undefined && (
        <span className="w-[5ch] text-right text-[11px] text-fg-faint tabular-nums">
          {trend.label}
        </span>
      )}
    </span>
  );
}
