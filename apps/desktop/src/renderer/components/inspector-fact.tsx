import type { ReactNode, Ref } from "react";
import { CopyButton } from "./copy-button.js";

/**
 * One fact in a status popup's list (a project's, a chat's, a file's, a
 * workflow's): its label and value on the list's two columns, as one box
 * the pointer can rest on. With `copy`, the value's copy button sits at the
 * row's end, on its first line, and shows while the row is hovered or holds
 * keyboard focus; its place is kept, so nothing moves when it shows. It
 * copies `copy`, the whole value (a full path where the row shows a name).
 */
export function InspectorFact({
  term,
  copy,
  copyLabel = `Copy ${term.toLowerCase()}`,
  busy,
  oneLine = false,
  valueRef,
  valueProps,
  children,
}: {
  term: string;
  /** What the copy button copies; no button without it. */
  copy?: string;
  /** The button's name and hint; "Copy <term>" by default. */
  copyLabel?: string;
  busy?: boolean;
  /**
   * The value is one line or one control, maybe taller than a line of
   * text (a picker): label, value and button centre on it. Otherwise all
   * three start at the value's first line, however many it wraps to.
   */
  oneLine?: boolean;
  valueRef?: Ref<HTMLDivElement>;
  /** Data attributes for the value's box (a test id, a state). */
  valueProps?: Record<`data-${string}`, string | undefined>;
  children: ReactNode;
}) {
  return (
    <div
      data-copyable={copy !== undefined || undefined}
      className={`col-span-2 grid grid-cols-subgrid ${oneLine ? "items-center" : "items-start"}`}
    >
      <dt className="text-fg-faint">{term}</dt>
      <dd
        className={`flex min-w-0 gap-2 ${oneLine ? "items-center" : "items-start"}`}
        aria-busy={busy || undefined}
      >
        <div ref={valueRef} className="min-w-0 flex-1 text-fg" {...valueProps}>
          {children}
        </div>
        {copy !== undefined && (
          // One line of text tall: the button centres on the value's first
          // line (or on a one-line value) and never makes a row taller.
          <span className="flex h-[1lh] shrink-0 items-center">
            <CopyButton value={copy} label={copyLabel} />
          </span>
        )}
      </dd>
    </div>
  );
}
