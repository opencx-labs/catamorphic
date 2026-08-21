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
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { textStats } from "../lib/text-pills";
import type { ChatAttachmentView } from "./catamorphic/chat-timeline";

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

const formatBytes = (base64Length: number) => {
  const bytes = Math.round((base64Length * 3) / 4);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

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
  onOpen?: () => void;
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
  const anchorRef = useRef<HTMLSpanElement>(null);
  // mounted + open drive the popover's lifecycle: it mounts hidden, tweens
  // in, and on close tweens back out before unmounting — the exit mirrors
  // the entrance instead of blinking away.
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );
  const scheduleOpen = () => {
    clearTimeout(closeTimer.current);
    if (open) return;
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      setMounted(true);
      setOpen(true);
    }, 260);
  };
  const scheduleClose = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    // A short grace so the pointer can travel into the popover (to scroll
    // a long paste) without it vanishing mid-way.
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };
  const closeNow = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setOpen(false);
    setMounted(false);
  };
  // Removal hides the preview immediately — a popover for a vanishing pill
  // reads as a leftover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeNow only touches refs + one setter
  useEffect(() => {
    if (exiting) closeNow();
  }, [exiting]);

  const label =
    view.kind === "text" && view.source.type === "tab"
      ? view.source.title
      : view.name;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only preview anchor; the ✕ is the real control
    <span
      ref={anchorRef}
      data-testid={testId}
      data-pill-kind={view.kind === "text" ? view.source.type : view.kind}
      className={`inline-flex h-5 max-w-full items-center overflow-hidden whitespace-nowrap align-[-4px] ${PILL_SURFACE} ${
        exiting ? "animate-pill-out" : animateIn ? "animate-pill-in" : ""
      } ${className}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "pill-out") onExited?.();
      }}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mousedown only guards the caret; the body is a hover surface, and a tab pill's open-on-click has the button role */}
      <span
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? -1 : undefined}
        onClick={onOpen}
        onKeyDown={
          onOpen
            ? (event) => {
                if (event.key === "Enter") onOpen();
              }
            : undefined
        }
        onMouseDown={(event: ReactMouseEvent) => {
          // Keep the composer's caret where it is; a click on a pill isn't a
          // request to move it.
          if (onRemove) event.preventDefault();
        }}
        className={`flex h-full min-w-0 items-center gap-1 pl-1.5 ${
          onRemove ? "pr-0.5" : "pr-1.5"
        } ${onOpen ? "cursor-pointer" : ""}`}
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
      </span>
      {onRemove && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            closeNow();
            onRemove();
          }}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-accent/55 transition-colors duration-100 hover:bg-accent/15 hover:text-accent"
          aria-label={`Remove ${label}`}
          tabIndex={-1}
        >
          <X className="size-3" />
        </button>
      )}
      {mounted && (
        <PillPreview
          view={view}
          anchor={anchorRef.current}
          open={open}
          onExited={() => setMounted(false)}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={scheduleClose}
        />
      )}
    </span>
  );
}

/**
 * The hover preview: a fixed popover above (or, when cramped, below) the
 * pill, clamped to the viewport. Portal-rendered so overflow-clipped hosts
 * (the composer scrolls, the timeline scrolls) never cut it off.
 */
function PillPreview({
  view,
  anchor,
  open,
  onExited,
  onMouseEnter,
  onMouseLeave,
}: {
  view: PillView;
  anchor: HTMLElement | null;
  /** false = play the exit transition; onExited fires when it lands. */
  open: boolean;
  onExited: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    below: boolean;
  } | null>(null);
  // Placed once on mount; `shown` follows `open` a frame later so both the
  // entrance and the exit run their transition.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
  }, [open]);

  useLayoutEffect(() => {
    const popover = ref.current;
    if (!anchor || !popover) return;
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(
        rect.left + rect.width / 2 - width / 2,
        window.innerWidth - width - margin,
      ),
    );
    const roomAbove = rect.top - margin;
    const below =
      roomAbove < height + 6 && rect.bottom + height + 6 < window.innerHeight;
    setPlacement(
      below
        ? { left, top: rect.bottom + 6, below }
        : { left, bottom: window.innerHeight - rect.top + 6, below },
    );
  }, [anchor]);

  const Icon = pillIcon(view);
  const header = (
    <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
      <Icon className="size-3 shrink-0" />
      <span className="truncate font-medium text-fg">
        {view.kind === "text" && view.source.type === "tab"
          ? view.source.title
          : view.name}
      </span>
      <span className="ml-auto shrink-0 text-fg-faint">
        {view.kind === "text"
          ? view.source.type === "paste" || view.source.type === "selection"
            ? textStats(view.text)
            : pillKindLabel(view)
          : `${pillKindLabel(view)} · ${formatBytes(view.dataBase64.length)}`}
      </span>
    </div>
  );

  const body =
    view.kind === "text" ? <TextBody view={view} /> : <MediaBody view={view} />;

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-testid="pill-preview"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={
        placement
          ? {
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
            }
          : { left: -9999, top: 0 }
      }
      onTransitionEnd={(event) => {
        if (event.propertyName === "opacity" && !open) onExited();
      }}
      className={`fixed z-[60] w-[26rem] max-w-[calc(100vw-16px)] rounded-lg border border-border bg-bg-overlay p-2.5 shadow-2xl transition-[opacity,translate] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
        shown
          ? "translate-y-0 opacity-100"
          : placement?.below
            ? "-translate-y-1 opacity-0"
            : "translate-y-1 opacity-0"
      }`}
    >
      {header}
      {body}
    </div>,
    document.body,
  );
}

function MediaBody({ view }: { view: MediaView }) {
  if (view.kind === "image") {
    return (
      <img
        src={dataUrl(view)}
        alt={view.name}
        className="mt-1.5 max-h-64 max-w-full rounded-md object-contain"
        draggable={false}
      />
    );
  }
  const text = decodeDocumentPreview(view);
  return text ? (
    <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted">
      {text}
    </pre>
  ) : (
    <p className="mt-1 text-[11px] text-fg-faint">{view.mediaType}</p>
  );
}

function TextBody({ view }: { view: TextView }) {
  if (view.source.type === "tab") {
    const where = view.source.url ?? view.source.filePath;
    return (
      <p className="mt-1 break-all text-[11px] leading-4 text-fg-muted">
        {where ?? `${view.source.kind} tab`}
      </p>
    );
  }
  if (view.source.type === "url" || view.source.type === "path") {
    return (
      <p className="mt-1 break-all font-mono text-[11px] leading-4 text-fg-muted">
        {view.text}
      </p>
    );
  }
  return (
    <>
      {view.source.type === "selection" && (
        <p className="mt-0.5 truncate text-[11px] text-fg-faint">
          {view.source.filePath}
        </p>
      )}
      <pre
        className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted"
        data-testid="pill-preview-text"
      >
        {view.text}
      </pre>
    </>
  );
}
