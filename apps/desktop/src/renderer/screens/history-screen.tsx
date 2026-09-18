import { History, Search, Trash2, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { HistoryEntry } from "../../shared/history.js";
import type { OpenMode } from "../../shared/open-mode.js";
import { Modal } from "../components/modal.js";
import { OpenResourceButton } from "../components/open-resource-button.js";
import { PendingButton } from "../components/pending-button.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import { SiteFavicon } from "../components/site-favicon.js";
import { desktopApi } from "../lib/desktop-api.js";
import { HISTORY_ICONS, historyDetail, useHistory } from "../lib/history.js";
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
export function HistoryScreen({
  profileId,
  active = true,
  onSearch,
  onOpen,
  onClose,
}: {
  profileId?: string;
  active?: boolean;
  onSearch: () => void;
  onOpen: (entry: HistoryEntry, mode: OpenMode) => Promise<void>;
  onClose: () => void;
}) {
  const runtime = useWorkspace();
  const [offset, setOffset] = useState(0);
  const history = useHistory({
    profileId,
    offset,
    enabled: runtime.visible && active,
  });
  useEffect(() => {
    if (
      !history.loading &&
      !history.error &&
      offset > 0 &&
      offset >= history.total
    )
      setOffset(Math.max(0, Math.ceil(history.total / 100 - 1) * 100));
  }, [history.loading, history.error, history.total, offset]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useListMotion(list, history.entries.map(({ id }) => id).join("\n"));
  const open = async (entry: HistoryEntry, mode: OpenMode) => {
    setError(null);
    try {
      await onOpen(entry, mode);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This item is no longer available.",
      );
    }
  };
  const remove = async (id: string) => {
    try {
      await desktopApi.historyRemove(id);
    } catch {
      setError("Could not remove this entry. Try again.");
    }
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    setError(null);
    try {
      await desktopApi.historyClear();
      setOffset(0);
      setConfirmClear(false);
    } catch {
      setError("Could not clear history. Try again.");
    } finally {
      setClearing(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-page">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <History className="size-4 text-fg-muted" />
        <h1 className="min-w-0 flex-1 text-sm font-medium text-fg">History</h1>
        <ShortcutHint label="Search history">
          <button
            type="button"
            aria-label="Search history"
            onClick={onSearch}
            className="grid size-7 place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <Search className="size-4" />
          </button>
        </ShortcutHint>
        <ShortcutHint label="Clear history">
          <button
            type="button"
            disabled={!history.total}
            data-disabled-reason="History is empty"
            aria-label="Clear history"
            onClick={() => setConfirmClear(true)}
            className="grid size-7 place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
        </ShortcutHint>
        <ShortcutHint label="Close history">
          <button
            type="button"
            aria-label="Close history"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </ShortcutHint>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        <div ref={list} className="mx-auto max-w-3xl">
          {history.entries.map((entry, index) => {
            const day = dayLabel(entry.lastVisitAt);
            const Icon = HISTORY_ICONS[entry.target.kind];
            return (
              <Fragment key={entry.id}>
                {(index === 0 ||
                  day !==
                    dayLabel(history.entries[index - 1]?.lastVisitAt ?? 0)) && (
                  <h2 className="pb-2 pt-5 text-xs font-medium text-fg-muted">
                    {day}
                  </h2>
                )}
                <div
                  data-item-id={entry.id}
                  className="group flex min-w-0 items-center gap-1 rounded-md transition-colors duration-150 hover:bg-bg-overlay focus-within:bg-bg-overlay"
                >
                  <OpenResourceButton
                    onOpen={(mode) => void open(entry, mode)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left"
                  >
                    {entry.target.kind === "web" && entry.faviconUrl ? (
                      <SiteFavicon
                        url={entry.target.url}
                        faviconUrl={entry.faviconUrl}
                        className="size-4 shrink-0"
                      />
                    ) : (
                      <Icon className="size-4 shrink-0 text-fg-muted" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">
                        {entry.title}
                      </span>
                      <span className="block truncate text-xs text-fg-faint">
                        {historyDetail(entry)}
                      </span>
                    </span>
                    <time
                      dateTime={new Date(entry.lastVisitAt).toISOString()}
                      className="shrink-0 text-[11px] tabular-nums text-fg-faint"
                    >
                      {new Date(entry.lastVisitAt).toLocaleTimeString(
                        undefined,
                        { hour: "numeric", minute: "2-digit" },
                      )}
                    </time>
                  </OpenResourceButton>
                  <ShortcutHint label="Remove from history">
                    <button
                      type="button"
                      aria-label={`Remove ${entry.title} from history`}
                      onClick={() => void remove(entry.id)}
                      className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-fg-muted opacity-0 transition-opacity duration-150 hover:bg-bg-raised group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </ShortcutHint>
                </div>
              </Fragment>
            );
          })}
          {!history.entries.length && (
            <p className="py-16 text-center text-[13px] text-fg-muted">
              {history.loading
                ? "Loading history…"
                : (history.error ??
                  "Pages and work you open will appear here.")}
            </p>
          )}
          {(error || history.error) && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error ?? history.error}
            </p>
          )}
          {history.error && (
            <button
              type="button"
              onClick={history.refresh}
              className="mt-2 text-xs text-fg-muted underline"
            >
              Try again
            </button>
          )}
          {(offset > 0 || history.total > offset + history.entries.length) && (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <button
                type="button"
                disabled={offset === 0}
                data-disabled-reason="Showing the most recent history"
                onClick={() => setOffset((value) => Math.max(0, value - 100))}
                className="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-overlay disabled:opacity-40"
              >
                Newer
              </button>
              <span className="text-xs tabular-nums text-fg-faint">
                {offset + 1} - {offset + history.entries.length} of{" "}
                {history.total}
              </span>
              <button
                type="button"
                disabled={offset + history.entries.length >= history.total}
                data-disabled-reason="Showing the oldest history"
                onClick={() => setOffset((value) => value + 100)}
                className="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-overlay disabled:opacity-40"
              >
                Older
              </button>
            </div>
          )}
        </div>
      </div>
      <Modal
        open={confirmClear}
        onClose={() => {
          if (!clearing) setConfirmClear(false);
        }}
        labelledBy="clear-history-title"
        width={360}
      >
        <div className="p-5">
          <h2
            id="clear-history-title"
            className="text-sm font-semibold text-fg"
          >
            Clear history?
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-fg-muted">
            Remove this profile's visit history. Your files, projects and
            browser accounts stay in place.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={clearing}
              data-disabled-reason="Wait for history to finish clearing"
              onClick={() => setConfirmClear(false)}
              className="h-8 rounded-md border border-border px-3 text-xs text-fg-muted hover:bg-bg-overlay"
            >
              Cancel
            </button>
            <PendingButton
              pending={clearing}
              onClick={() => void clear()}
              className="h-8 rounded-md bg-danger px-3 text-xs text-white"
            >
              Clear history
            </PendingButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}
