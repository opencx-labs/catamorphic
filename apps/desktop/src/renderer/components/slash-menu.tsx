import { type RefObject, useEffect, useRef } from "react";
import type { SlashEntry } from "../lib/slash-commands";
import { PopPanel } from "./pop-panel";

/** The input retains focus while its active descendant moves through this list. */
export function SlashMenu({
  id,
  anchorRef,
  open,
  matches,
  selected,
  loading,
  error,
  onRetry,
  onHover,
  onCommit,
  onDismiss,
}: {
  id: string;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  matches: SlashEntry[];
  selected: number;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onHover: (index: number) => void;
  onCommit: (entry: SlashEntry) => void;
  onDismiss: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const selectedName = matches[selected]?.name;
  // biome-ignore lint/correctness/useExhaustiveDependencies: async catalog changes can move the active row
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [open, selected, selectedName]);
  return (
    <PopPanel
      open={open}
      anchorRef={anchorRef}
      testId="slash-menu"
      className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-raised shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-fg-muted">
        <span>Commands</span>
        <span className="text-fg-faint">
          {loading ? "Loading…" : `${matches.length} available`}
        </span>
      </div>
      <div
        ref={list}
        id={id}
        role="listbox"
        aria-label="Commands"
        aria-busy={loading}
        className="min-h-0 max-h-[min(20rem,45vh)] overflow-y-auto overscroll-contain p-1"
      >
        {matches.map((entry, index) => (
          <button
            type="button"
            key={entry.name}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === selected}
            data-skill-name={entry.name}
            tabIndex={-1}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => onCommit(entry)}
            onMouseMove={() => onHover(index)}
            className={`w-full cursor-pointer rounded-md border-l-2 px-2 py-2 text-left text-sm transition-colors duration-100 ${index === selected ? "border-accent bg-bg-overlay text-fg" : "border-transparent text-fg-muted"}`}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-medium">
                {entry.kind === "skill" ? entry.title : `/${entry.name}`}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                {entry.source}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs leading-relaxed text-fg-muted">
              {entry.description || entry.title}
            </span>
          </button>
        ))}
        {!matches.length && (
          <p
            role="status"
            className="px-2 py-5 text-center text-xs text-fg-muted"
          >
            {loading
              ? "Looking for commands…"
              : "No matching commands. Keep typing or send as a message."}
          </p>
        )}
      </div>
      {error && (
        <div
          role="status"
          className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-fg-muted"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-fg hover:bg-bg-overlay focus-visible:outline focus-visible:outline-accent"
            onClick={onRetry}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onDismiss();
              }
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div className="min-h-7 truncate border-t border-border px-3 py-1.5 text-[11px] text-fg-muted">
        {matches[selected]
          ? `/${matches[selected]?.name} ${matches[selected]?.argumentHint ?? ""}`
          : "Type a command name to filter"}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-fg-faint">
        <span>↑ ↓ Navigate</span>
        <span>Tab Add arguments</span>
        <span>Enter Run</span>
        <span>Esc Dismiss</span>
      </div>
    </PopPanel>
  );
}
