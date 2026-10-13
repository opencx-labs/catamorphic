import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { ShortcutHint } from "./shortcut-hint.js";

const COPIED_MS = 1500;

/**
 * An icon button that copies `value`, for a value shown beside it (a path,
 * an address). The copy icon turns into a check for a moment once the
 * clipboard has it, in the same footprint, and assistive technology hears
 * that it was copied. Its hint names what it copies.
 */
export function CopyButton({
  value,
  label,
}: {
  value: string;
  /** What it copies, as its accessible name and hint ("Copy Git remote"). */
  label: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copied = state === "copied";
  return (
    <>
      <ShortcutHint label={label}>
        <button
          type="button"
          aria-label={label}
          data-copied={copied || undefined}
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => setState("copied"),
              () => setState("failed"),
            );
          }}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
        >
          <Copy
            aria-hidden="true"
            className={`col-start-1 row-start-1 size-3 transition-opacity duration-150 ${copied ? "opacity-0" : "opacity-100"}`}
          />
          <Check
            aria-hidden="true"
            className={`col-start-1 row-start-1 size-3 text-success transition-opacity duration-150 ${copied ? "opacity-100" : "opacity-0"}`}
          />
        </button>
      </ShortcutHint>
      <span className="sr-only" role="status">
        {copied ? "Copied" : state === "failed" ? "Could not copy" : ""}
      </span>
    </>
  );
}
