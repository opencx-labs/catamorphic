import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.js";

export interface BarListItem {
  /** Stable key for the row. */
  key: string;
  /** Row label; truncates in narrow columns. */
  label: ReactNode;
  /** The measured quantity, 0 or more. */
  value: number;
  /** Text shown at the row's end; defaults to the value formatted by `format`. */
  display?: ReactNode;
}

/**
 * Horizontal bars for "how much of each": sessions per day, files touched,
 * time per topic. Bars scale to the largest value and take the accent at low
 * chroma, so a chart reads as part of the app rather than a poster. Rows
 * are plain list items; hand `onSelect` to make them clickable.
 */
export function BarList({
  items,
  format = (value) => String(value),
  max,
  onSelect,
  className,
  ...rest
}: {
  items: BarListItem[];
  /** Formats the value shown at the row's end. */
  format?: (value: number) => ReactNode;
  /** Scale reference; defaults to the largest value in `items`. */
  max?: number;
  /** Makes rows buttons; receives the item's key. */
  onSelect?: (key: string) => void;
} & Omit<ComponentProps<"ul">, "children">) {
  const top = Math.max(max ?? 0, ...items.map((item) => item.value), 0);
  return (
    <ul {...rest} className={cx("cat-bars", className)}>
      {items.map((item) => {
        const width = top > 0 ? (Math.max(0, item.value) / top) * 100 : 0;
        const body = (
          <>
            <span className="cat-bar-label">{item.label}</span>
            <span className="cat-bar-track" aria-hidden="true">
              <span className="cat-bar-fill" style={{ width: `${width}%` }} />
            </span>
            <span className="cat-bar-value">
              {item.display ?? format(item.value)}
            </span>
          </>
        );
        return (
          <li key={item.key} className="cat-bar">
            {onSelect ? (
              <button
                type="button"
                className="cat-bar-row cat-bar-row--button"
                onClick={() => onSelect(item.key)}
              >
                {body}
              </button>
            ) : (
              <span className="cat-bar-row">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
