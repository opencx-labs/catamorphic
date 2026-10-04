import { Download, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type DownloadRecord,
  downloadOpensInWork,
  isActiveDownload,
} from "../../shared/downloads.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  describeDownload,
  downloadIcon,
  downloadProgress,
  useDownloads,
} from "../lib/downloads.js";
import { ShortcutHint } from "./shortcut-hint.js";

/**
 * When the bubble was last closed, per profile (downloads are a profile's,
 * and every window shares this storage); downloads started before stay
 * hidden.
 */
const dismissedKey = (profileId: string) =>
  `downloads-bubble-dismissed-at:${profileId}`;
function readDismissedAt(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Downloads in the dock (ADR 0153): Chrome keeps a download button in its
 * toolbar; Work keeps it in the dock, beside the chats. A ring fills as
 * the bytes arrive, a tick marks a finished download nobody has looked
 * at yet, and the bubble opens the last few with a way to the full page.
 * Absent until something has been downloaded. Like a chat bubble it can
 * be closed once nothing is downloading; the next download brings it back.
 */
export function DownloadsBubble({
  align = "center",
  onOpenAll,
  onOpenFile,
  onOpenChange,
}: {
  /**
   * Which edge of the bubble the popover lines up with. The strip resting
   * at a side of the screen opens it toward the middle: centered, half of
   * it would hang past the window's edge.
   */
  align?: "start" | "center" | "end";
  onOpenAll: () => void;
  /** Open a saved file in Work (the dock's owner decides where). */
  onOpenFile: (record: DownloadRecord) => void;
  /** The detached dock grows its window while the popover is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { downloads } = useDownloads();
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(0);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [dismissedAt, setDismissedAt] = useState(0);
  // Closing: when the close was pressed, kept until the exit has played.
  const [closingAt, setClosingAt] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void desktopApi
      .windowProfile()
      .catch(() => "")
      .then((id) => {
        if (!current) return;
        setProfileId(id);
        setDismissedAt(readDismissedAt(dismissedKey(id)));
      });
    return () => {
      current = false;
    };
  }, []);
  // The other dock window (detached or in the workspace) closed it too.
  useEffect(() => {
    if (profileId === null) return;
    const key = dismissedKey(profileId);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) setDismissedAt(readDismissedAt(key));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [profileId]);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = downloads.filter(isActiveDownload);
  const dismissed =
    active.length === 0 &&
    downloads.every((record) => record.startedAt <= dismissedAt);
  const hidden = profileId === null || downloads.length === 0 || dismissed;
  // Back after a close in this window: it pops in like a new chat bubble.
  // A window opening on it as it was shows it still.
  const wasDismissed = useRef(false);
  const popIn = useRef(false);
  if (wasDismissed.current && !hidden) popIn.current = true;
  useEffect(() => {
    if (profileId === null || downloads.length === 0) return;
    wasDismissed.current = dismissed;
    if (dismissed) popIn.current = false;
  }, [profileId, downloads.length, dismissed]);
  // A hidden bubble has no open popover, and the detached dock's window
  // takes back the room it lent.
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => {
    onOpenChangeRef.current?.(open && !hidden);
  }, [open, hidden]);
  useEffect(() => () => onOpenChangeRef.current?.(false), []);
  const unseen = downloads.some(
    (record) =>
      record.state === "completed" &&
      (record.finishedAt ?? 0) > seenAt &&
      !isActiveDownload(record),
  );
  const total = active.reduce(
    (sum, record) => sum + (record.totalBytes > 0 ? record.totalBytes : 0),
    0,
  );
  const received = active.reduce(
    (sum, record) => sum + (record.totalBytes > 0 ? record.receivedBytes : 0),
    0,
  );
  const ring = active.length > 0 && total > 0 ? received / total : null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  if (hidden) return null;
  const recent = downloads.slice(0, 5);
  // A download that starts while the bubble leaves brings it back.
  const dismiss = (at: number) => {
    try {
      localStorage.setItem(dismissedKey(profileId), String(at));
    } catch {
      // Without storage it stays closed until this window reloads.
    }
    setClosingAt(null);
    setDismissedAt(at);
  };
  const toggle = () => {
    setOpen((value) => !value);
    setSeenAt(Date.now());
  };
  const circumference = 2 * Math.PI * 16;
  return (
    <div
      ref={rootRef}
      data-testid="downloads-bubble-root"
      className={`relative ${
        closingAt !== null
          ? "animate-bubble-out pointer-events-none"
          : popIn.current
            ? "animate-bubble-in"
            : ""
      }`}
      onAnimationEnd={(event) => {
        if (event.animationName === "bubble-out" && closingAt !== null)
          dismiss(closingAt);
      }}
    >
      {/* Hovering the bubble reveals its close control; the popover stays
          outside the group so its rows reveal their own. */}
      <div className="group relative">
        <ShortcutHint
          label={
            active.length > 0
              ? `${active.length} ${active.length === 1 ? "download" : "downloads"} in progress`
              : "Downloads"
          }
          side="top"
        >
          <button
            type="button"
            onClick={toggle}
            aria-label="Downloads"
            aria-expanded={open}
            data-testid="downloads-bubble"
            data-active={active.length > 0 || undefined}
            className={`relative grid size-9 cursor-pointer place-items-center rounded-full border transition-colors duration-150 ${
              open
                ? "border-border-strong bg-bg-overlay text-fg"
                : "border-border text-fg-muted hover:border-border-strong hover:text-fg"
            }`}
          >
            {ring !== null && (
              <svg
                aria-hidden="true"
                viewBox="0 0 36 36"
                className="absolute inset-0 size-full -rotate-90"
              >
                <circle
                  cx="18"
                  cy="18"
                  r="16"
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeOpacity="0.25"
                  strokeWidth="2"
                />
                <circle
                  cx="18"
                  cy="18"
                  r="16"
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - ring)}
                  className="transition-[stroke-dashoffset] duration-200"
                />
              </svg>
            )}
            <Download
              className={`size-4 ${active.length > 0 ? "animate-pulse" : ""}`}
            />
            {unseen && !open && (
              <span
                aria-hidden="true"
                data-testid="downloads-unseen"
                className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-bg-raised bg-accent"
              />
            )}
          </button>
        </ShortcutHint>
        {active.length === 0 && closingAt === null && (
          <button
            type="button"
            onClick={() => {
              const at = Date.now();
              setOpen(false);
              if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
                dismiss(at);
              else setClosingAt(at);
            }}
            data-testid="downloads-bubble-close"
            className="row-reveal absolute -left-1 -top-1 grid size-4 cursor-pointer place-items-center rounded-full border border-border bg-bg-overlay text-fg-faint hover:text-fg"
            aria-label="Close downloads"
          >
            <X className="size-2.5" />
          </button>
        )}
      </div>
      {open && (
        <div
          role="dialog"
          aria-label="Recent downloads"
          data-testid="downloads-popover"
          data-align={align}
          className={`animate-pop-in absolute bottom-12 w-80 rounded-xl border border-border bg-bg-raised p-1.5 shadow-2xl ${
            align === "start"
              ? "left-0 origin-bottom-left"
              : align === "end"
                ? "right-0 origin-bottom-right"
                : "left-1/2 -translate-x-1/2"
          }`}
        >
          <ul className="flex flex-col">
            {recent.map((record) => {
              const Icon = downloadIcon(record.filename);
              const progress = downloadProgress(record);
              const openable =
                record.state === "completed" &&
                record.exists &&
                downloadOpensInWork(record.filename);
              return (
                <li key={record.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (openable) onOpenFile(record);
                      else void desktopApi.downloadsReveal({ id: record.id });
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-bg-overlay"
                  >
                    <Icon className="size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg">
                        {record.filename}
                      </span>
                      <span className="block truncate text-[11px] text-fg-faint">
                        {describeDownload(record)}
                      </span>
                      {progress !== null && (
                        <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-bg-inset">
                          <span
                            className="block h-full rounded-full bg-accent transition-[width] duration-150"
                            style={{ width: `${progress * 100}%` }}
                          />
                        </span>
                      )}
                    </span>
                  </button>
                  {isActiveDownload(record) ? (
                    <ShortcutHint label="Cancel download">
                      <button
                        type="button"
                        aria-label={`Cancel ${record.filename}`}
                        onClick={() =>
                          void desktopApi.downloadsCancel({ id: record.id })
                        }
                        className="row-reveal mr-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-overlay"
                      >
                        <X className="size-3" />
                      </button>
                    </ShortcutHint>
                  ) : (
                    <ShortcutHint label="Show in Finder">
                      <button
                        type="button"
                        aria-label={`Show ${record.filename} in Finder`}
                        onClick={() =>
                          void desktopApi.downloadsReveal({ id: record.id })
                        }
                        className="row-reveal mr-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-overlay"
                      >
                        <FolderOpen className="size-3" />
                      </button>
                    </ShortcutHint>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenAll();
            }}
            data-testid="downloads-show-all"
            className="mt-1 flex h-8 w-full cursor-pointer items-center justify-center rounded-md border-t border-border text-[12px] text-fg-muted transition-colors duration-150 hover:text-fg"
          >
            Show all downloads
          </button>
        </div>
      )}
    </div>
  );
}
