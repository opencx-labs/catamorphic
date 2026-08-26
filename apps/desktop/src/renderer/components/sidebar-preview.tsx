import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SidebarPreview } from "../lib/desktop-api.js";

export const SIDEBAR_PREVIEW_DELAY_MS = 500;

export interface SidebarPreviewAnchor {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Portal-rendered inspector card for a sidebar row. Fixed positioning keeps
 * it outside the sidebar's clipping scroll container; the layout pass flips
 * it to the row's left and clamps it vertically when the viewport is tight.
 * Its layer clears workspace overlays such as New Tab (z-100), while staying
 * below app-level transitions and consent surfaces.
 */
export function SidebarPreviewPopover({
  id,
  open,
  anchor,
  preview,
  fallbackTitle,
  onMouseEnter,
  onMouseLeave,
  onExited,
}: {
  id: string;
  open: boolean;
  anchor: SidebarPreviewAnchor;
  preview: SidebarPreview;
  fallbackTitle: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onExited: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: anchor.right + 8,
    top: anchor.top,
  });

  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left =
      anchor.right + 8 + width <= window.innerWidth - 8
        ? anchor.right + 8
        : Math.max(8, anchor.left - width - 8);
    const top = Math.max(
      8,
      Math.min(anchor.top, window.innerHeight - height - 8),
    );
    setPosition({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-testid="sidebar-preview"
      style={position}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) onExited();
      }}
      className={`pointer-events-auto fixed z-[120] w-72 rounded-lg border border-border bg-bg-overlay p-2.5 shadow-2xl ${
        open ? "animate-pop-in" : "animate-pop-out"
      }`}
    >
      <p className="break-words text-[12px] font-medium leading-4 text-fg">
        {preview.title ?? fallbackTitle}
      </p>
      {preview.description && (
        <p className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-fg-muted">
          {preview.description}
        </p>
      )}
      {preview.metadata && preview.metadata.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] leading-4">
          {preview.metadata.map((entry) => (
            <div key={`${entry.label}:${entry.value}`} className="contents">
              <dt className="font-mono text-[10px] uppercase tracking-wide text-fg-faint">
                {entry.label}
              </dt>
              <dd className="truncate text-right text-fg-muted">
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>,
    document.body,
  );
}
