import type { ReactNode } from "react";
import type { SidebarPreview } from "../lib/desktop-api.js";
import {
  InspectorPortal,
  RESOURCE_INSPECTOR_DELAY_MS,
} from "./resource-inspector";

export const SIDEBAR_PREVIEW_DELAY_MS = RESOURCE_INSPECTOR_DELAY_MS;

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
  content,
  fallbackTitle,
  onMouseEnter,
  onMouseLeave,
  onExited,
}: {
  id: string;
  open: boolean;
  anchor: SidebarPreviewAnchor;
  preview?: SidebarPreview;
  content?: ReactNode;
  fallbackTitle: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onExited: () => void;
}) {
  return (
    <InspectorPortal
      id={id}
      label={fallbackTitle}
      testId={content === undefined ? "sidebar-preview" : undefined}
      anchor={anchor}
      open={open}
      onEnter={onMouseEnter}
      onLeave={onMouseLeave}
      onExited={onExited}
    >
      {content ?? (
        <>
          <p className="break-words text-[12px] font-medium leading-4 text-fg">
            {preview?.title ? preview.title : fallbackTitle}
          </p>
          {preview?.description && (
            <p className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-fg-muted">
              {preview.description}
            </p>
          )}
          {preview?.metadata && preview.metadata.length > 0 && (
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
        </>
      )}
    </InspectorPortal>
  );
}
