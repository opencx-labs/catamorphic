import { useItemActions } from "@catamorphic/app/ui";
import { type ReactNode, useContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SidebarMenuEntry } from "../../shared/sidebar.js";
import type { SidebarPreview } from "../lib/desktop-api.js";
import { TONE_TEXT } from "../lib/tones.js";
import { AppScreen } from "../screens/app-screen.js";
import { FilePreviewProjectContext } from "./file-preview.js";
import { InspectorFact } from "./inspector-fact.js";
import { PendingButton } from "./pending-button.js";
import {
  InspectorPortal,
  RESOURCE_INSPECTOR_DELAY_MS,
} from "./resource-inspector";
import { useSidebarContribution } from "./sidebar-contribution.js";
import { useSidebarHost } from "./sidebar-host.js";

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
  onAction,
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
  onAction?: (entry: SidebarMenuEntry) => unknown;
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
        <PreviewCard
          preview={preview}
          fallbackTitle={fallbackTitle}
          onAction={onAction}
        />
      )}
    </InspectorPortal>
  );
}

/** Readable facts and rich content use the same inspector for rows and chips. */
export function PreviewCard({
  preview,
  fallbackTitle,
  onAction,
}: {
  preview?: SidebarPreview;
  fallbackTitle: string;
  onAction?: (entry: SidebarMenuEntry) => unknown;
}) {
  const host = useSidebarHost(),
    contribution = useSidebarContribution();
  const contextProject = useContext(FilePreviewProjectContext);
  const projectId = host?.projectId ?? contextProject;
  return (
    <>
      <p className="break-words text-[12px] font-medium leading-4 text-fg">
        {preview?.title || fallbackTitle}
      </p>
      {preview?.description && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-fg-muted">
          {preview.description}
        </p>
      )}
      {!!preview?.metadata?.length && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border pt-2 text-[11px] leading-4">
          {preview.metadata.map((entry) => (
            <InspectorFact
              key={entry.label}
              term={entry.label}
              copy={entry.copy}
            >
              <div className="group/fact flex min-w-0 flex-col gap-1">
                <span
                  className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${entry.tone ? TONE_TEXT[entry.tone] : "text-fg-muted"} ${entry.display === "code" ? "font-mono" : entry.display === "badge" ? "w-fit rounded bg-bg-raised px-1.5 py-0.5" : ""}`}
                >
                  {entry.display === "color" && entry.color && (
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-block size-2.5 rounded-sm border border-border"
                      style={{ backgroundColor: entry.color }}
                    />
                  )}
                  {entry.value}
                </span>
                <PreviewActions
                  entries={entry.actions}
                  onAction={onAction}
                  quiet
                />
              </div>
            </InspectorFact>
          ))}
        </dl>
      )}
      {preview?.content && (
        <div className="mt-2 min-w-0 border-t border-border pt-2">
          {"markdown" in preview.content ? (
            <div className="cat-markdown break-words text-xs [overflow-wrap:anywhere]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  img: () => null,
                  a: ({ href, children }) => (
                    <button
                      type="button"
                      className="text-accent underline"
                      disabled={!href || !onAction}
                      onClick={() => {
                        if (href)
                          void onAction?.({
                            action: "open",
                            label: String(children),
                            url: href,
                          });
                      }}
                    >
                      {children}
                    </button>
                  ),
                }}
              >
                {preview.content.markdown}
              </ReactMarkdown>
            </div>
          ) : projectId ? (
            <AppScreen
              key={JSON.stringify(preview.content)}
              hostContext={{ inspector: preview.content.data }}
              projectId={projectId}
              appName={preview.content.app}
              compact
              height={preview.content.height ?? 240}
              surface={contribution?.surface}
            />
          ) : (
            <p className="text-xs text-fg-muted">
              Open this inspector in its project to view the app.
            </p>
          )}
        </div>
      )}
      <PreviewActions entries={preview?.actions} onAction={onAction} />
    </>
  );
}
function PreviewActions({
  entries,
  onAction,
  quiet = false,
}: {
  entries?: SidebarMenuEntry[];
  onAction?: (entry: SidebarMenuEntry) => unknown;
  quiet?: boolean;
}) {
  const { pending, error, run } = useItemActions();
  if (!entries?.length) return null;
  return (
    <div
      className={
        quiet
          ? "flex flex-wrap gap-1 opacity-0 transition-opacity group-hover/fact:opacity-100 group-focus-within/fact:opacity-100"
          : "mt-2 flex flex-wrap gap-1"
      }
    >
      {entries.map((e) => (
        <PendingButton
          key={`${e.action}:${e.url ?? e.label}`}
          type="button"
          pending={pending === e.action}
          disabled={!onAction || Boolean(e.disabledReason)}
          data-disabled-reason={e.disabledReason}
          className={`button-ghost text-xs ${e.danger ? "text-danger" : ""}`}
          onClick={() =>
            void run({
              id: e.action,
              label: e.label,
              disabledReason: e.disabledReason,
              run: async () => {
                await onAction?.(e);
              },
            })
          }
        >
          {e.label}
        </PendingButton>
      ))}
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
