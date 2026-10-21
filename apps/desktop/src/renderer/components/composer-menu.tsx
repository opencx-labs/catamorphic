import { ChevronRight } from "lucide-react";
import {
  Fragment,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import type { ComposerMenuRow } from "../lib/composer-menu-rows.js";
import { useListMotion } from "../lib/list-motion.js";
import { pointerMoved } from "../lib/pointer-moved.js";
import { themeStyle, useTheme } from "../lib/theme.js";
import { PopPanel } from "./pop-panel.js";

/**
 * A composer's "/" and "@" menu (ADR 0273): one compact list above the
 * composer while the caret ends a "/" or "@" word. The composer keeps the
 * keyboard (its textbox names the highlighted row as its active
 * descendant); this list only draws, follows the pointer and takes clicks.
 * It closes with the word: the caret leaving it, Escape, the composer
 * losing focus.
 */
export function ComposerMenu({
  id,
  open,
  label,
  anchorRef,
  rows,
  selected,
  onHover,
  onPick,
  onExited,
}: {
  id: string;
  open: boolean;
  /** What the list holds, for assistive technology. */
  label: string;
  anchorRef: RefObject<HTMLElement | null>;
  rows: readonly ComposerMenuRow[];
  selected: number;
  onHover: (index: number) => void;
  onPick: (row: ComposerMenuRow) => void;
  onExited?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const motion = useListMotion(listRef, rows, {
    keepTransitions: "background-color 100ms, color 100ms",
  });
  // Rendered at the body in its chat's theme, as every overlay is: a
  // detached dock then counts it among what it draws, and takes its clicks.
  const theme = useTheme();
  const motionRef = useRef(motion);
  motionRef.current = motion;
  // A reopened menu paints fresh: no rows gliding from the last word's list.
  useLayoutEffect(() => {
    if (!open) motionRef.current.reset();
  }, [open]);
  // The highlighted row stays in view as the arrows move it or rows
  // re-rank; a row the pointer chose is where the person already looks.
  const hovered = useRef<string | null>(null);
  const selectedId = rows[selected]?.id;
  useEffect(() => {
    if (!open || !selectedId || hovered.current === selectedId) return;
    listRef.current
      ?.querySelector(`[data-item-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, selectedId]);
  return createPortal(
    <div
      data-theme={theme?.appearance}
      style={themeStyle(theme)}
      className="contents"
    >
      <PopPanel
        open={open}
        anchorRef={anchorRef}
        onExited={onExited}
        testId="composer-menu"
        className="flex flex-col overflow-hidden rounded-(--menu-radius) border border-border bg-bg-raised shadow-lg [--menu-padding:--spacing(1)] [--menu-radius:var(--radius-xl)]"
      >
        <div
          ref={listRef}
          id={id}
          role="listbox"
          aria-label={label}
          className="max-h-[24.5rem] min-h-0 overflow-y-auto overscroll-contain p-(--menu-padding)"
          onMouseLeave={() => {
            hovered.current = null;
          }}
        >
          {rows.map((row, index) => {
            const Icon = row.icon;
            const isSelected = index === selected;
            const heading =
              row.group && row.group !== rows[index - 1]?.group
                ? row.group
                : null;
            if (row.loading)
              // A catalog still loading holds its line with a still bar.
              return (
                <div
                  key={row.id}
                  data-item-id={row.id}
                  role="status"
                  className="flex h-8 items-center gap-2.5 px-2.5"
                >
                  <span className="sr-only">{row.label}</span>
                  <span className="size-4 shrink-0 rounded bg-bg-overlay" />
                  <span className="h-2 w-40 rounded-full bg-bg-overlay" />
                </div>
              );
            return (
              <Fragment key={row.id}>
                {heading && (
                  <div
                    aria-hidden="true"
                    className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-fg-faint first:pt-1"
                  >
                    {heading}
                  </div>
                )}
                <button
                  type="button"
                  id={`${id}-${index}`}
                  role="option"
                  tabIndex={-1}
                  data-item-id={row.id}
                  data-pick={row.pick.kind}
                  aria-selected={isSelected}
                  // The composer keeps focus and its caret.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={(event) => {
                    if (!pointerMoved(event) || isSelected) return;
                    hovered.current = row.id;
                    onHover(index);
                  }}
                  onClick={() => onPick(row)}
                  className={`flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-[calc(var(--menu-radius)-var(--menu-padding))] px-2.5 text-left text-[0.8125rem] transition-colors duration-100 ${
                    isSelected ? "bg-bg-overlay text-fg" : "text-fg"
                  }`}
                >
                  <Icon
                    aria-hidden="true"
                    className={`size-4 shrink-0 ${isSelected ? "text-fg-muted" : "text-fg-faint"}`}
                  />
                  <span className="min-w-0 max-w-[60%] shrink-0 truncate">
                    {row.label}
                  </span>
                  {row.detail && (
                    <span className="min-w-0 truncate text-fg-faint">
                      {row.detail}
                    </span>
                  )}
                  {row.opens && (
                    <ChevronRight
                      aria-hidden="true"
                      className="ml-auto size-4 shrink-0 text-fg-faint"
                    />
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      </PopPanel>
    </div>,
    document.body,
  );
}
