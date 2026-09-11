import {
  ClipboardType,
  FileCode,
  FileText,
  Globe,
  Link2,
  type LucideIcon,
  MessageSquare,
  SquareTerminal,
  TextQuote,
  X,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from "react";
import { type OpenMode, openModeFromEvent } from "../../shared/open-mode.js";
import { textStats } from "../lib/text-pills";
import type { ChatAttachmentView } from "./catamorphic/chat-timeline";
import { ResourcePreviewContent } from "./catamorphic/resource-preview";
import { FilePreview } from "./file-preview";
import { ResourceInspector } from "./resource-inspector";
import { WebPreview } from "./web-preview";

/**
 * The context pill: one visual for everything the user pins beside their
 * words — pastes, editor selections, links, paths, open tabs, images and
 * documents — wherever it appears (inline in the composer, inline in a
 * sent message, the palette's mode chip). It borrows the palette chip's
 * surface (accent tint, accent text, rounded-md, 12px medium) so the app
 * has ONE "this is a token" look.
 *
 * Hovering a pill previews what it holds (the pasted text, the image, the
 * tab's address) in a popover; the pill itself stays a compact token so a
 * message reads as prose with references, not as a wall of wells.
 */

/** The palette chip's surface — shared so composer/timeline/palette match. */
export const PILL_SURFACE =
  "rounded-md bg-accent/15 text-[12px] font-medium text-accent";

export type PillView = ChatAttachmentView;
type MediaView = Extract<PillView, { mediaType: string }>;
type TextView = Extract<PillView, { kind: "text" }>;

const SOURCE_ICONS: Record<string, LucideIcon> = {
  paste: ClipboardType,
  selection: TextQuote,
  url: Link2,
  path: FileText,
};

const TAB_KIND_ICONS: Record<string, LucideIcon> = {
  browser: Globe,
  editor: FileCode,
  terminal: SquareTerminal,
  chat: MessageSquare,
};

const SOURCE_LABELS: Record<string, string> = {
  paste: "Pasted text",
  selection: "Selection",
  url: "Link",
  path: "File path",
  tab: "Open tab",
};

export function pillIcon(view: PillView): LucideIcon {
  if (view.kind === "text") {
    if (view.source.type === "tab") {
      return TAB_KIND_ICONS[view.source.kind] ?? Globe;
    }
    return SOURCE_ICONS[view.source.type] ?? FileText;
  }
  return FileText;
}

/** Short kind label for headers ("Selection", "Image", "PDF"…). */
export function pillKindLabel(view: PillView): string {
  if (view.kind === "text") return SOURCE_LABELS[view.source.type] ?? "Text";
  if (view.kind === "image") return "Image";
  return "Document";
}

const dataUrl = (view: MediaView) =>
  `data:${view.mediaType};base64,${view.dataBase64}`;

const TEXT_DOCUMENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** Decode a text-ish document's first bytes for the preview well. */
function decodeDocumentPreview(view: MediaView): string | null {
  if (!TEXT_DOCUMENT_TYPES.has(view.mediaType)) return null;
  try {
    // 6KB of base64 ≈ 4.5KB of text — plenty for a glance.
    const bytes = Uint8Array.from(atob(view.dataBase64.slice(0, 6000)), (c) =>
      c.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export interface ContextPillProps {
  view: PillView;
  /** Shows a ✕ that removes the pill (composer); omitted = read-only. */
  onRemove?: () => void;
  /** Mid pill-out; the parent drops the element on animation end. */
  exiting?: boolean;
  onExited?: () => void;
  /** Whether arrival plays pill-in (composer inserts do; history doesn't). */
  animateIn?: boolean;
  /** Clicking the body (e.g. open a tab pill's tab). */
  onOpen?: (mode: OpenMode) => void;
  className?: string;
  /** Extra data-* for tests. */
  testId?: string;
}

export function ContextPill({
  view,
  onRemove,
  exiting = false,
  onExited,
  animateIn = true,
  onOpen,
  className = "",
  testId = "context-pill",
}: ContextPillProps) {
  const Icon = pillIcon(view);
  const exitedRef = useRef(onExited);
  exitedRef.current = onExited;
  useEffect(() => {
    if (!exiting) return;
    // Editing another inline pill can cancel Chromium's animation event.
    const timer = window.setTimeout(() => exitedRef.current?.(), 220);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  const label =
    view.kind === "text" && view.source.type === "tab"
      ? view.source.title
      : view.name;

  return (
    <ResourceInspector
      label={`Preview ${view.name}`}
      testId="pill-preview"
      disabled={exiting}
      pinOnClick={!onOpen}
      content={
        view.kind === "text" ? (
          <TextBody view={view} />
        ) : (
          <MediaBody view={view} />
        )
      }
    >
      {({ onPointerEnter, onPointerLeave, ...previewProps }) => (
        <span
          data-testid={testId}
          data-pill-kind={view.kind === "text" ? view.source.type : view.kind}
          className={`inline-flex h-5 max-w-full items-center overflow-hidden whitespace-nowrap align-[-4px] ${PILL_SURFACE} ${exiting ? "animate-pill-out" : animateIn ? "animate-pill-in" : ""} ${className}`}
          onAnimationEnd={(event) => {
            if (event.animationName === "pill-out") onExited?.();
          }}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        >
          <button
            {...previewProps}
            type="button"
            onClick={(event) => {
              previewProps.onClick();
              onOpen?.(openModeFromEvent(event));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ")
                event.stopPropagation();
            }}
            onMouseDown={(event: ReactMouseEvent) => {
              if (onRemove) event.preventDefault();
            }}
            className={`flex h-full min-w-0 items-center gap-1 pl-1.5 ${onRemove ? "pr-0.5" : "pr-1.5"} ${onOpen ? "cursor-pointer" : ""}`}
          >
            {view.kind === "image" ? (
              <img
                src={dataUrl(view)}
                alt=""
                className="size-4 shrink-0 rounded-[3px] object-cover"
                draggable={false}
              />
            ) : (
              <Icon className="size-3.5 shrink-0" />
            )}
            <span className="max-w-52 truncate">{label}</span>
          </button>
          {onRemove && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
              className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-accent/55 transition-colors duration-100 hover:bg-accent/15 hover:text-accent"
              aria-label={`Remove ${label}`}
              tabIndex={-1}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      )}
    </ResourceInspector>
  );
}

function MediaBody({ view }: { view: MediaView }) {
  if (view.kind === "document" && !TEXT_DOCUMENT_TYPES.has(view.mediaType))
    return <FilePreview document={view} />;
  const text = decodeDocumentPreview(view);
  return (
    <ResourcePreviewContent
      preview={{
        name: view.name,
        typeLabel: pillKindLabel(view),
        sizeBytes: Math.floor((view.dataBase64.length * 3) / 4),
        content:
          view.kind === "image"
            ? { kind: "image", src: dataUrl(view) }
            : text !== null
              ? {
                  kind: "text",
                  text,
                  truncated: view.dataBase64.length > 6000,
                  ...(view.mediaType === "text/markdown" ||
                  /\.(md|markdown)$/i.test(view.name)
                    ? { format: "markdown" }
                    : {}),
                }
              : {
                  kind: "unavailable",
                  message: `No inline preview is available for ${view.mediaType}.`,
                },
      }}
    />
  );
}

function TextBody({ view }: { view: TextView }) {
  if (view.source.type === "url" && /^https?:\/\//i.test(view.source.url))
    return <WebPreview url={view.source.url} />;
  if (view.source.type === "path")
    return <FilePreview filePath={view.source.path} />;
  if (view.source.type === "tab" && view.source.filePath)
    return <FilePreview filePath={view.source.filePath} />;
  if (
    view.source.type === "tab" &&
    view.source.url &&
    /^https?:\/\//i.test(view.source.url)
  )
    return <WebPreview url={view.source.url} />;
  const location =
    view.source.type === "selection"
      ? view.source.filePath
      : view.source.type === "url"
        ? view.source.url
        : view.source.type === "tab"
          ? view.source.url
          : undefined;
  const excerpt =
    view.source.type === "paste" || view.source.type === "selection";
  return (
    <ResourcePreviewContent
      preview={{
        name: view.source.type === "tab" ? view.source.title : view.name,
        typeLabel: excerpt ? textStats(view.text) : pillKindLabel(view),
        location,
        content: excerpt
          ? {
              kind: "text",
              text: view.text.slice(0, 16000),
              truncated: view.text.length > 16000,
            }
          : {
              kind: "unavailable",
              message:
                view.source.type === "tab" ? `${view.source.kind} tab` : "Link",
            },
      }}
    />
  );
}
