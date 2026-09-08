import { Columns2, Maximize2, Minus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { ShortcutHint } from "./shortcut-hint.js";

/** The content remains mounted when its floating frame becomes a tab or tile. */
export function FloatingPanelBar({
  title,
  canTile,
  onExpand,
  onTile,
  onHide,
  onClose,
}: {
  title: string;
  canTile: boolean;
  onExpand: () => void;
  onTile: () => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const controlsRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    controlsRef.current?.focus();
  }, []);
  const bindings = useKeybindings();
  const button =
    "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40";
  return (
    <fieldset
      ref={controlsRef}
      tabIndex={-1}
      aria-label={`${title} panel controls`}
      data-floating-panel-bar
      className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border bg-bg-raised px-3"
    >
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
        {title}
      </span>
      <ShortcutHint
        label="Hide floating panel"
        shortcut={formatBinding(bindings["dismiss-floating"])}
      >
        <button
          type="button"
          aria-label="Hide floating panel"
          className={button}
          onClick={onHide}
        >
          <Minus className="size-3.5" />
        </button>
      </ShortcutHint>
      <ShortcutHint
        label="Open as full tab"
        shortcut={formatBinding(bindings["floating-to-tab"])}
      >
        <button
          type="button"
          aria-label="Open as full tab"
          className={button}
          onClick={onExpand}
        >
          <Maximize2 className="size-3.5" />
        </button>
      </ShortcutHint>
      <ShortcutHint
        label="Tile beside current tab"
        shortcut={formatBinding(bindings["floating-to-split"])}
      >
        <button
          type="button"
          aria-label="Tile beside current tab"
          className={button}
          disabled={!canTile}
          onClick={onTile}
        >
          <Columns2 className="size-4" />
        </button>
      </ShortcutHint>
      <ShortcutHint
        label="Close floating tab"
        shortcut={formatBinding(bindings["close-tab"])}
      >
        <button
          type="button"
          aria-label="Close floating tab"
          className={button}
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </ShortcutHint>
    </fieldset>
  );
}
