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
 * Downloads in the dock (ADR 0153): Chrome keeps a download button in its
 * toolbar; Work keeps it in the dock, beside the chats. A ring fills as
 * the bytes arrive, a tick marks a finished download nobody has looked
 * at yet, and the bubble opens the last few with a way to the full page.
 * Absent until something has been downloaded.
 */
export function DownloadsBubble({
  onOpenAll,
  onOpenFile,
}: {
  onOpenAll: () => void;
  /** Open a saved file in Work (the dock's owner decides where). */
  onOpenFile: (record: DownloadRecord) => void;
}) {
  const { downloads } = useDownloads();
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = downloads.filter(isActiveDownload);
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

  if (downloads.length === 0) return null;
  const recent = downloads.slice(0, 5);
  const toggle = () => {
    setOpen((value) => !value);
    setSeenAt(Date.now());
  };
  const circumference = 2 * Math.PI * 16;
  return (
    <div ref={rootRef} className="relative">
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
      {open && (
        <div
          role="dialog"
          aria-label="Recent downloads"
          data-testid="downloads-popover"
          className="animate-pop-in absolute bottom-12 left-1/2 w-80 -translate-x-1/2 rounded-xl border border-border bg-bg-raised p-1.5 shadow-2xl"
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
