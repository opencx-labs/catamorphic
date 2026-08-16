import type { AgentChatTextAttachment } from "@catamorphic/react";
import {
  ChevronRight,
  ClipboardType,
  FileText,
  Link2,
  TextQuote,
  X,
} from "lucide-react";
import { useState } from "react";
import { textStats } from "../lib/text-pills.js";

/**
 * A text-context pill in the composer: collapsed by default (icon, label,
 * stats, ✕), expandable to a read-only mono well showing the full text.
 * Enters with pill-in and leaves with pill-out (the palette mode chip's
 * motion at pill width): the removed pill lingers mid-tween until
 * `animationend`, then the parent drops it. Read-only on purpose — editing a 40KB paste inside
 * a pill is a worse editor than wherever it came from; delete and re-paste
 * is the honest path.
 */

const SOURCE_ICONS = {
  paste: ClipboardType,
  selection: TextQuote,
  url: Link2,
  path: FileText,
} as const;

const SOURCE_LABELS = {
  paste: "Pasted text",
  selection: "Selection",
  url: "Link",
  path: "File path",
} as const;

export interface ComposerPillProps {
  attachment: AgentChatTextAttachment;
  /** Mid chip-out; the parent removes the element on animation end. */
  exiting?: boolean;
  onRemove: () => void;
  onExited?: () => void;
}

export function ComposerPill({
  attachment,
  exiting = false,
  onRemove,
  onExited,
}: ComposerPillProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = SOURCE_ICONS[attachment.source.type];
  const isReference =
    attachment.source.type === "url" || attachment.source.type === "path";
  const canExpand = !isReference;

  return (
    <div
      className={`min-w-0 max-w-full ${exiting ? "animate-pill-out" : "animate-pill-in"}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "pill-out") onExited?.();
      }}
      data-testid="composer-pill"
      data-source={attachment.source.type}
    >
      <div
        className={`flex min-w-0 items-stretch overflow-hidden rounded-lg border border-border bg-bg-inset text-[11px] text-fg-muted transition-colors duration-150 ${
          expanded ? "border-border-strong" : ""
        }`}
      >
        <button
          type="button"
          onClick={canExpand ? () => setExpanded((value) => !value) : undefined}
          className={`flex min-w-0 items-center gap-1.5 py-1.5 pl-2 pr-1.5 text-left ${
            canExpand
              ? "cursor-pointer transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              : "cursor-default"
          }`}
          aria-expanded={canExpand ? expanded : undefined}
          title={
            isReference
              ? attachment.text
              : `${SOURCE_LABELS[attachment.source.type]} — click to ${expanded ? "collapse" : "expand"}`
          }
        >
          <Icon className="size-3.5 shrink-0 text-fg-faint" />
          <span className="max-w-56 truncate font-medium text-fg">
            {attachment.name}
          </span>
          {!isReference && (
            <span className="shrink-0 text-fg-faint">
              {textStats(attachment.text)}
            </span>
          )}
          {canExpand && (
            <ChevronRight
              className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          )}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="grid w-6 shrink-0 cursor-pointer place-items-center border-l border-border text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          aria-label={`Remove ${attachment.name}`}
        >
          <X className="size-3" />
        </button>
      </div>
      {/* Grid-rows tween (the turn-step log's pattern): the well stays
          mounted, so collapse mirrors expansion exactly. */}
      {canExpand && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <pre
              className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted"
              data-testid="composer-pill-text"
            >
              {attachment.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
