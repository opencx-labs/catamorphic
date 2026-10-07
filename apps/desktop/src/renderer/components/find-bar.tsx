import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { PopPanel } from "./pop-panel.js";
import { ShortcutHint } from "./shortcut-hint.js";

/** Where a find in page stands: the current match of how many. */
export interface FindResult {
  active: number;
  matches: number;
}

/**
 * Chrome's find bar, for the top right of a page: typing searches as it
 * goes, Enter and Shift+Enter (or the arrows) step through the matches,
 * Escape closes it and hands focus back to the page.
 */
export function FindBar({
  open,
  ...fields
}: { open: boolean } & FindFieldsProps) {
  return (
    <PopPanel
      open={open}
      testId="find-bar"
      className="pointer-events-auto flex h-11 w-80 max-w-full origin-top-right items-center gap-0.5 rounded-lg border border-border bg-bg-overlay pl-2 pr-1.5 shadow-2xl"
    >
      <FindFields {...fields} />
    </PopPanel>
  );
}

interface FindFieldsProps {
  query: string;
  /** The page's latest answer for `query`; null while it has none. */
  result: FindResult | null;
  /** Changes each time the bar is asked for: its input takes focus, all selected. */
  focusRequest: number;
  onQueryChange: (query: string) => void;
  onStep: (direction: "next" | "previous") => void;
  onClose: () => void;
}

/** The bar's contents, mounted with the panel so they can take focus at once. */
function FindFields({
  query,
  result,
  focusRequest,
  onQueryChange,
  onStep,
  onClose,
}: FindFieldsProps) {
  const keybindings = useKeybindings();
  const inputRef = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus per request
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);
  const none = result?.matches === 0;
  const button =
    "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <>
      <div className="field mr-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2">
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          autoComplete="off"
          aria-label="Find in page"
          aria-keyshortcuts={keybindings.find}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
          placeholder="Find in page"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onStep(event.shiftKey ? "previous" : "next");
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        {query && result && (
          <output
            aria-live="polite"
            data-testid="find-count"
            className={`shrink-0 text-xs tabular-nums ${none ? "text-danger" : "text-fg-faint"}`}
          >
            {result.active}/{result.matches}
          </output>
        )}
      </div>
      <ShortcutHint
        label="Previous match"
        shortcut={formatBinding(keybindings["find-previous"])}
      >
        <button
          type="button"
          aria-label="Previous match"
          disabled={!result?.matches}
          onClick={() => onStep("previous")}
          className={button}
        >
          <ChevronUp className="size-4" />
        </button>
      </ShortcutHint>
      <ShortcutHint
        label="Next match"
        shortcut={formatBinding(keybindings["find-next"])}
      >
        <button
          type="button"
          aria-label="Next match"
          disabled={!result?.matches}
          onClick={() => onStep("next")}
          className={button}
        >
          <ChevronDown className="size-4" />
        </button>
      </ShortcutHint>
      <ShortcutHint label="Close" shortcut="Esc">
        <button
          type="button"
          aria-label="Close find bar"
          onClick={onClose}
          className={button}
        >
          <X className="size-3.5" />
        </button>
      </ShortcutHint>
    </>
  );
}
