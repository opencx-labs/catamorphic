import {
  Download,
  FolderOpen,
  Pause,
  Play,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import {
  type DownloadRecord,
  downloadOpensInWork,
  isActiveDownload,
} from "../../shared/downloads.js";
import type { OpenMode } from "../../shared/open-mode.js";
import { Modal } from "../components/modal.js";
import { OpenResourceButton } from "../components/open-resource-button.js";
import { PendingButton } from "../components/pending-button.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import {
  type ContextMenuEntry,
  MenuPortal,
} from "../components/sidebar-item-row.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  describeDownload,
  downloadIcon,
  downloadProgress,
  useDownloads,
} from "../lib/downloads.js";
import { useListMotion } from "../lib/list-motion.js";
import { useWorkspace } from "../lib/workspace-context.js";

function dayLabel(time: number): string {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

const MENU: readonly ContextMenuEntry[] = [
  { label: "Open", action: "open" },
  { label: "Show in Finder", action: "reveal" },
  { label: "Copy download link", action: "copy-link" },
  { label: "Remove from list", action: "remove", danger: true },
];

/**
 * Every download of the profile (ADR 0153), newest first, by day. A row
 * opens its file in Work when Work can show it, else reveals it in the
 * file manager; the usual open gestures apply. Right-click for the rest.
 */
export function DownloadsScreen({
  active = true,
  onOpen,
}: {
  active?: boolean;
  /** Open the saved file in Work (a browser tab) with an open mode. */
  onOpen: (record: DownloadRecord, mode: OpenMode) => void;
}) {
  const runtime = useWorkspace();
  const { downloads, loaded } = useDownloads(runtime.visible && active);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [menu, setMenu] = useState<{
    record: DownloadRecord;
    position: { x: number; y: number };
    open: boolean;
  } | null>(null);
  const filtered = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return downloads.filter((record) =>
      words.every((word) =>
        `${record.filename} ${record.host ?? ""}`.toLowerCase().includes(word),
      ),
    );
  }, [downloads, query]);
  const finished = downloads.filter((record) => !isActiveDownload(record));
  const list = useRef<HTMLDivElement>(null);
  useListMotion(list, filtered.map(({ id }) => id).join("\n"));

  const open = (record: DownloadRecord, mode: OpenMode) => {
    if (record.state !== "completed" || !record.exists) {
      void desktopApi.downloadsReveal({ id: record.id });
      return;
    }
    if (downloadOpensInWork(record.filename)) onOpen(record, mode);
    else void desktopApi.downloadsReveal({ id: record.id });
  };
  const pick = (record: DownloadRecord, action: string) => {
    if (action === "open") open(record, "replace");
    else if (action === "reveal")
      void desktopApi.downloadsReveal({ id: record.id });
    else if (action === "copy-link")
      void navigator.clipboard.writeText(record.url);
    else if (action === "remove")
      void desktopApi.downloadsRemove({ id: record.id });
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await desktopApi.downloadsClear();
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="downloads-page">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Download className="size-4 text-fg-muted" />
        <h1 className="min-w-0 flex-1 text-sm font-medium text-fg">
          Downloads
        </h1>
        <label className="field flex h-7 w-56 items-center gap-2 rounded-full px-3">
          <Search className="size-3.5 shrink-0 text-fg-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter downloads"
            aria-label="Filter downloads"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        <ShortcutHint label="Open downloads folder">
          <button
            type="button"
            aria-label="Open downloads folder"
            onClick={() => void desktopApi.downloadsOpenFolder()}
            className="grid size-7 place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <FolderOpen className="size-4" />
          </button>
        </ShortcutHint>
        <ShortcutHint label="Clear finished downloads">
          <button
            type="button"
            disabled={finished.length === 0}
            data-disabled-reason="Nothing finished to clear"
            aria-label="Clear finished downloads"
            onClick={() => setConfirmClear(true)}
            className="grid size-7 place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
        </ShortcutHint>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        <div ref={list} className="mx-auto max-w-3xl">
          {filtered.map((record, index) => {
            const day = dayLabel(record.startedAt);
            const previous = filtered[index - 1];
            return (
              <Fragment key={record.id}>
                {(index === 0 ||
                  day !== dayLabel(previous?.startedAt ?? 0)) && (
                  <h2 className="pb-2 pt-5 text-xs font-medium text-fg-muted">
                    {day}
                  </h2>
                )}
                <DownloadRow
                  record={record}
                  onOpen={(mode) => open(record, mode)}
                  onMenu={(position) =>
                    setMenu({ record, position, open: true })
                  }
                />
              </Fragment>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-16 text-center text-[13px] text-fg-muted">
              {!loaded
                ? "Reading downloads…"
                : query
                  ? "No download matches."
                  : "Files you download will appear here."}
            </p>
          )}
        </div>
      </div>
      {menu && (
        <MenuPortal
          open={menu.open}
          position={menu.position}
          entries={MENU}
          onPick={(entry) => {
            pick(menu.record, entry.action);
            setMenu((current) => current && { ...current, open: false });
          }}
          onDismiss={() =>
            setMenu((current) => current && { ...current, open: false })
          }
          onExited={() => setMenu(null)}
        />
      )}
      <Modal
        open={confirmClear}
        onClose={() => {
          if (!clearing) setConfirmClear(false);
        }}
        labelledBy="clear-downloads-title"
        width={360}
      >
        <div className="p-5">
          <h2
            id="clear-downloads-title"
            className="text-sm font-semibold text-fg"
          >
            Clear finished downloads?
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-fg-muted">
            The list forgets {finished.length}{" "}
            {finished.length === 1 ? "download" : "downloads"}. The files stay
            where they are.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={clearing}
              data-disabled-reason="Wait for the list to finish clearing"
              onClick={() => setConfirmClear(false)}
              className="button-ghost"
            >
              Cancel
            </button>
            <PendingButton
              pending={clearing}
              onClick={() => void clear()}
              className="button-danger"
            >
              Clear
            </PendingButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DownloadRow({
  record,
  onOpen,
  onMenu,
}: {
  record: DownloadRecord;
  onOpen: (mode: OpenMode) => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const Icon = downloadIcon(record.filename);
  const progress = downloadProgress(record);
  const active = isActiveDownload(record);
  const gone =
    record.state === "cancelled" ||
    record.state === "interrupted" ||
    (record.state === "completed" && !record.exists);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the row's menu; every action is also a button inside the row
    <div
      data-item-id={record.id}
      data-testid="download-row"
      data-state={record.state}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      className="group flex min-w-0 items-center gap-1 rounded-md transition-colors duration-150 hover:bg-bg-overlay focus-within:bg-bg-overlay"
    >
      <OpenResourceButton
        onOpen={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left"
      >
        <Icon
          className={`size-4 shrink-0 ${gone ? "text-fg-faint" : "text-fg-muted"}`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] ${
              gone ? "text-fg-muted line-through" : "text-fg"
            }`}
          >
            {record.filename}
          </span>
          <span className="block truncate text-xs text-fg-faint">
            {describeDownload(record)}
          </span>
          {progress !== null && (
            <span
              className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-bg-inset"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${progress * 100}%` }}
              />
            </span>
          )}
        </span>
        <time
          dateTime={new Date(record.startedAt).toISOString()}
          className="shrink-0 text-[11px] tabular-nums text-fg-faint"
        >
          {new Date(record.startedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </OpenResourceButton>
      {active ? (
        <>
          <ShortcutHint label={record.state === "paused" ? "Resume" : "Pause"}>
            <button
              type="button"
              aria-label={
                record.state === "paused"
                  ? `Resume ${record.filename}`
                  : `Pause ${record.filename}`
              }
              disabled={record.state === "paused" && !record.canResume}
              data-disabled-reason="This server does not resume downloads"
              onClick={() =>
                void (record.state === "paused"
                  ? desktopApi.downloadsResume({ id: record.id })
                  : desktopApi.downloadsPause({ id: record.id }))
              }
              className="row-reveal grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-raised disabled:opacity-40"
            >
              {record.state === "paused" ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </button>
          </ShortcutHint>
          <ShortcutHint label="Cancel download">
            <button
              type="button"
              aria-label={`Cancel ${record.filename}`}
              onClick={() => void desktopApi.downloadsCancel({ id: record.id })}
              className="row-reveal mr-1 grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-raised"
            >
              <X className="size-3.5" />
            </button>
          </ShortcutHint>
        </>
      ) : (
        <>
          <ShortcutHint label="Show in Finder">
            <button
              type="button"
              aria-label={`Show ${record.filename} in Finder`}
              disabled={gone}
              data-disabled-reason="This file is no longer on disk"
              onClick={() => void desktopApi.downloadsReveal({ id: record.id })}
              className="row-reveal grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-raised disabled:opacity-40"
            >
              <FolderOpen className="size-3.5" />
            </button>
          </ShortcutHint>
          <ShortcutHint label="Remove from list">
            <button
              type="button"
              aria-label={`Remove ${record.filename} from the list`}
              onClick={() => void desktopApi.downloadsRemove({ id: record.id })}
              className="row-reveal mr-1 grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-raised"
            >
              <X className="size-3.5" />
            </button>
          </ShortcutHint>
        </>
      )}
    </div>
  );
}
