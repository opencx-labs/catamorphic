import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ShortcutHint } from "./shortcut-hint.js";

const SHOWN_MS = 1500;

/**
 * An icon button that copies `value`, for a value shown beside it (a path,
 * an address, a command). It rests hidden in its place until its copyable
 * item, the nearest element marked `data-copyable` (the row holding the
 * value and the button), is hovered or holds keyboard focus. Its icon
 * turns into a check once the clipboard has it, or a cross if the copy
 * failed, in the same footprint, for a moment that starts again with every
 * press; the button stays shown for that moment and assistive technology
 * hears each outcome. Its hint names what it copies.
 */
export function CopyButton({
  value,
  label,
}: {
  value: string;
  /** What it copies, as its accessible name and hint ("Copy Git remote"). */
  label: string;
}) {
  // A new object per press: the moment restarts, and the announcement
  // differs from the last one so it is read again.
  const [outcome, setOutcome] = useState<{
    copied: boolean;
    press: number;
  } | null>(null);
  const presses = useRef(0);
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [outcome]);
  const copied = outcome?.copied === true;
  const failed = outcome?.copied === false;
  const icon = (shown: boolean) =>
    `col-start-1 row-start-1 size-3 transition-opacity duration-150 ${shown ? "opacity-100" : "opacity-0"}`;
  return (
    <>
      <ShortcutHint label={label}>
        <button
          type="button"
          aria-label={label}
          data-copied={copied || undefined}
          data-copy-failed={failed || undefined}
          onClick={() => {
            const press = ++presses.current;
            navigator.clipboard.writeText(value).then(
              () => setOutcome({ copied: true, press }),
              () => setOutcome({ copied: false, press }),
            );
          }}
          className="copy-reveal grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-faint hover:bg-bg-raised hover:text-fg"
        >
          <Copy aria-hidden="true" className={icon(!outcome)} />
          <Check
            aria-hidden="true"
            className={`${icon(copied)} text-success`}
          />
          <X aria-hidden="true" className={`${icon(failed)} text-danger`} />
        </button>
      </ShortcutHint>
      <span className="sr-only" role="status">
        {outcome
          ? `${outcome.copied ? "Copied" : "Could not copy"}${" ".repeat((outcome.press + 1) % 2)}`
          : ""}
      </span>
    </>
  );
}
