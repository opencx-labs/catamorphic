import type { KeyboardEvent, MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button.js";
import {
  addDays,
  addMonths,
  type DateRange,
  daysInMonth,
  fromIsoDate,
  isoMonth,
  maxIso,
  minIso,
  todayIso,
} from "./dates.js";

const DOW_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export type CalendarProps =
  | {
      mode?: "single";
      /** Selected day (ISO `YYYY-MM-DD`) or null. */
      value: string | null;
      /** Fired with the clicked day, or null from the Clear affordance. */
      onSelect: (day: string | null) => void;
    }
  | {
      mode: "range";
      value: DateRange | null;
      /**
       * Fired only with a COMPLETE range (or null from Clear). The first
       * click never commits: it marks "start chosen, end pending"; the
       * second click sets the end (clicking before the start restarts).
       */
      onSelect: (range: DateRange | null) => void;
    };

/**
 * Month calendar — single-day or range selection, no dependencies,
 * date-only local ISO strings.
 *
 * Accessibility follows the ARIA grid pattern with REAL focus movement:
 * `focusedDay` roves (one day is tabbable), and Arrow keys / PageUp /
 * PageDown / Home / End move actual DOM focus — the freshly focused day
 * button focuses itself in an effect — including across month boundaries,
 * where the visible month follows automatically. Screen readers track it
 * because it is genuine focus, not a highlight.
 *
 * Range polish: geometry renders through data attributes
 * (`data-range-start` / `data-range-middle` / `data-range-end` /
 * `data-selected-single`) so week-clipped ranges keep designed corners;
 * today wears a subtle ring; the selected day fills with the accent; the
 * Clear affordance renders only when there is something to clear.
 */
export function Calendar(props: CalendarProps) {
  const value = props.value;
  const initialAnchor =
    (typeof value === "string" ? value : value?.from) ?? todayIso();
  const [visibleMonth, setVisibleMonth] = useState(isoMonth(initialAnchor));
  const [focusedDay, setFocusedDay] = useState(initialAnchor);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const focusPending = useRef(false);

  const [yearString, monthString] = visibleMonth.split("-");
  const year = Number(yearString);
  const monthIndex = Number(monthString) - 1;
  const today = todayIso();

  const moveFocus = (day: string) => {
    focusPending.current = true;
    setFocusedDay(day);
    if (isoMonth(day) !== visibleMonth) setVisibleMonth(isoMonth(day));
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const jumps: Record<string, () => string> = {
      ArrowLeft: () => addDays(focusedDay, -1),
      ArrowRight: () => addDays(focusedDay, 1),
      ArrowUp: () => addDays(focusedDay, -7),
      ArrowDown: () => addDays(focusedDay, 7),
      PageUp: () => addMonths(focusedDay, -1),
      PageDown: () => addMonths(focusedDay, 1),
      Home: () => addDays(focusedDay, -fromIsoDate(focusedDay).getDay()),
      End: () => addDays(focusedDay, 6 - fromIsoDate(focusedDay).getDay()),
    };
    const jump = jumps[event.key];
    if (!jump) return;
    event.preventDefault();
    moveFocus(jump());
  };

  const onDayClick = (day: string) => {
    moveFocus(day);
    if (props.mode !== "range") {
      props.onSelect(day);
      return;
    }
    // THE FIRST-CLICK FIX: a single click never commits a 1-day range.
    if (pendingStart === null) {
      setPendingStart(day);
      return;
    }
    if (day < pendingStart) {
      // Clicking before the start restarts the range from there.
      setPendingStart(day);
      return;
    }
    props.onSelect({ from: pendingStart, to: day });
    setPendingStart(null);
  };

  // The range drawn on the grid: a committed value, or the in-progress
  // preview from the pending start to the hovered/focused day.
  const shown: DateRange | null =
    props.mode === "range"
      ? pendingStart !== null
        ? {
            from: minIso(pendingStart, hoverDay ?? pendingStart),
            to: maxIso(pendingStart, hoverDay ?? pendingStart),
          }
        : props.value
      : null;

  // Cells: leading days from the previous month, the month, trailing fill.
  const lead = fromIsoDate(`${visibleMonth}-01`).getDay();
  const total = Math.ceil((lead + daysInMonth(year, monthIndex)) / 7) * 7;
  const firstCell = addDays(`${visibleMonth}-01`, -lead);
  const weeks: string[][] = [];
  for (let i = 0; i < total; i += 7) {
    weeks.push(
      Array.from({ length: 7 }, (_, offset) => addDays(firstCell, i + offset)),
    );
  }

  const monthLabel = fromIsoDate(`${visibleMonth}-01`).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );
  const clearable =
    props.mode === "range"
      ? props.value !== null || pendingStart !== null
      : props.value !== null;

  return (
    <div className="cat-cal">
      <div className="cat-cal-header">
        <button
          type="button"
          className="cat-cal-nav"
          aria-label="Previous month"
          onClick={() =>
            setVisibleMonth(isoMonth(addMonths(`${visibleMonth}-01`, -1)))
          }
        >
          <Chevron direction="left" />
        </button>
        <span className="cat-cal-title" aria-live="polite">
          {monthLabel}
        </span>
        <button
          type="button"
          className="cat-cal-nav"
          aria-label="Next month"
          onClick={() =>
            setVisibleMonth(isoMonth(addMonths(`${visibleMonth}-01`, 1)))
          }
        >
          <Chevron direction="right" />
        </button>
      </div>
      {/* ARIA grid pattern over CSS grid, deliberately: `display: contents`
          week rows keep the 7-column layout AND the nth-child edge-rounding
          for week-clipped ranges, which real table elements can't express
          with these styles. Focus lives on the day gridcells (roving
          tabIndex); rows and column headers are structural. */}
      {/* biome-ignore lint/a11y/useSemanticElements: see above */}
      <div role="grid" aria-label={monthLabel}>
        {/* biome-ignore lint/a11y/useSemanticElements: see above */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: structural row */}
        <div role="row" className="cat-cal-dowrow">
          {DOW_LABELS.map((label) => (
            // biome-ignore lint/a11y/useSemanticElements: see above
            // biome-ignore lint/a11y/useFocusableInteractive: structural header
            <span key={label} role="columnheader" className="cat-cal-dow">
              {label}
            </span>
          ))}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: see above */}
        <div
          role="rowgroup"
          className="cat-cal-grid"
          onKeyDown={onGridKeyDown}
          onMouseLeave={() => setHoverDay(null)}
        >
          {weeks.map((week) => (
            // biome-ignore lint/a11y/useSemanticElements: see above
            // biome-ignore lint/a11y/useFocusableInteractive: structural row
            <div role="row" className="cat-cal-week" key={week[0]}>
              {week.map((day) => {
                const inRange =
                  shown !== null && day >= shown.from && day <= shown.to;
                const isStart = shown !== null && day === shown.from;
                const isEnd = shown !== null && day === shown.to;
                const isSingle = props.mode !== "range" && props.value === day;
                return (
                  <DayButton
                    key={day}
                    day={day}
                    outside={isoMonth(day) !== visibleMonth}
                    today={day === today}
                    focused={day === focusedDay}
                    focusPending={focusPending}
                    selected={isSingle || isStart || isEnd}
                    singleSelected={isSingle}
                    rangeStart={isStart}
                    rangeEnd={isEnd}
                    rangeMiddle={inRange && !isStart && !isEnd}
                    onClick={() => onDayClick(day)}
                    onHover={() => setHoverDay(day)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {clearable ? (
        <div className="cat-cal-footer">
          <Button
            variant="subtle"
            size="sm"
            onClick={() => {
              setPendingStart(null);
              if (props.mode === "range") props.onSelect(null);
              else props.onSelect(null);
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DayButton({
  day,
  outside,
  today,
  focused,
  focusPending,
  selected,
  singleSelected,
  rangeStart,
  rangeEnd,
  rangeMiddle,
  onClick,
  onHover,
}: {
  day: string;
  outside: boolean;
  today: boolean;
  focused: boolean;
  focusPending: MutableRefObject<boolean>;
  selected: boolean;
  singleSelected: boolean;
  rangeStart: boolean;
  rangeEnd: boolean;
  rangeMiddle: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // Focus follows the roving day: when keyboard navigation lands here —
  // including across a month switch that remounted the grid — take REAL
  // focus so screen readers announce the day.
  useEffect(() => {
    if (focused && focusPending.current) {
      focusPending.current = false;
      ref.current?.focus();
    }
  }, [focused, focusPending]);
  const date = fromIsoDate(day);
  return (
    // Day cells are buttons carrying role=gridcell — the ARIA grid pattern
    // with real, focusable, activatable controls (see the grid rationale).
    // biome-ignore lint/a11y/useSemanticElements: see above
    <button
      ref={ref}
      type="button"
      role="gridcell"
      className="cat-cal-day"
      tabIndex={focused ? 0 : -1}
      aria-selected={selected || rangeMiddle || undefined}
      aria-label={date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })}
      aria-current={today ? "date" : undefined}
      data-outside={outside || undefined}
      data-today={today || undefined}
      data-selected-single={singleSelected || undefined}
      data-range-start={rangeStart || undefined}
      data-range-end={rangeEnd || undefined}
      data-range-middle={rangeMiddle || undefined}
      onClick={onClick}
      onMouseEnter={onHover}
    >
      {date.getDate()}
    </button>
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={
          direction === "left"
            ? "M7.5 2.5 4 6l3.5 3.5"
            : "M4.5 2.5 8 6l-3.5 3.5"
        }
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
