import { useRef, useState } from "react";
import { Calendar } from "./calendar.js";
import { cx } from "./cx.js";
import { type DateRange, formatIsoDate } from "./dates.js";
import { useFieldContext } from "./field.js";
import { Popover } from "./popover.js";

/**
 * Single-date picker: an input-styled trigger opening a popover
 * {@link Calendar}. Dates are local ISO `YYYY-MM-DD` strings; no timezone
 * machinery. The clear affordance renders only while a value is set.
 * Inherits {@link Field} wiring (label id, described-by, invalid ring).
 */
export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
  invalid,
  className,
  id,
}: {
  /** Selected day (ISO `YYYY-MM-DD`) or null. */
  value: string | null;
  onChange: (day: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Marks the control invalid (`aria-invalid` + danger ring). */
  invalid?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const clearable = value !== null && !disabled;
  return (
    <span
      className={cx("cat-datepicker", className)}
      data-clearable={clearable || undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="cat-datepicker-trigger"
        id={id ?? field?.controlId}
        aria-describedby={field?.describedBy}
        aria-invalid={isInvalid || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        data-empty={value === null || undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarGlyph />
        <span>{value !== null ? formatIsoDate(value) : placeholder}</span>
      </button>
      {clearable ? (
        <button
          type="button"
          className="cat-datepicker-clear"
          aria-label="Clear date"
          onClick={() => onChange(null)}
        >
          <ClearGlyph />
        </button>
      ) : null}
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <Calendar
          value={value}
          onSelect={(day) => {
            onChange(day);
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      </Popover>
    </span>
  );
}

/**
 * Date-range picker: same trigger + popover, with the range
 * {@link Calendar}. The popover stays open after the first click (start
 * chosen, end pending — no 1-day range is committed) and closes when the
 * second click completes the range.
 */
export function DateRangePicker({
  value,
  onChange,
  placeholder = "Pick a date range",
  disabled,
  invalid,
  className,
  id,
}: {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Marks the control invalid (`aria-invalid` + danger ring). */
  invalid?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const clearable = value !== null && !disabled;
  return (
    <span
      className={cx("cat-datepicker", className)}
      data-clearable={clearable || undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="cat-datepicker-trigger"
        id={id ?? field?.controlId}
        aria-describedby={field?.describedBy}
        aria-invalid={isInvalid || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        data-empty={value === null || undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarGlyph />
        <span>
          {value !== null
            ? `${formatIsoDate(value.from)} – ${formatIsoDate(value.to)}`
            : placeholder}
        </span>
      </button>
      {clearable ? (
        <button
          type="button"
          className="cat-datepicker-clear"
          aria-label="Clear date range"
          onClick={() => onChange(null)}
        >
          <ClearGlyph />
        </button>
      ) : null}
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        <Calendar
          mode="range"
          value={value}
          onSelect={(range) => {
            onChange(range);
            if (range !== null) {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        />
      </Popover>
    </span>
  );
}

function CalendarGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="2.5"
        width="11"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M1.5 5.5h11" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 1v2.5M9.5 1v2.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m2 2 6 6M8 2 2 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
