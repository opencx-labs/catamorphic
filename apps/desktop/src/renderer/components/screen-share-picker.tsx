import { AppWindow, Monitor, MonitorUp, PanelTop, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ScreenShareChoice,
  ScreenShareKind,
  ScreenShareRequest,
  ScreenShareSource,
  ScreenShareSources,
} from "../../shared/screen-share.js";
import { siteHost } from "../../shared/site-settings.js";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { AnimatedHeight, ModalTab } from "./modal-tabs.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";

/**
 * Chrome's "Choose what to share" for a page's `getDisplayMedia` call
 * (ADR 0150): one of this window's tabs, an application window, or an
 * entire screen. Tab sharing can carry the tab's audio. Cancel, Escape or
 * a closed tab refuse the request; the page sees NotAllowedError.
 */
export function ScreenShareHost() {
  const [requests, setRequests] = useState<ScreenShareRequest[]>([]);
  useEffect(() => {
    const stopRequests = desktopApi.onScreenShareRequest((request) =>
      setRequests((queue) => [...queue, request]),
    );
    const stopWithdrawn = desktopApi.onScreenShareWithdrawn(({ ids }) =>
      setRequests((queue) =>
        queue.filter((request) => !ids.includes(request.id)),
      ),
    );
    return () => {
      stopRequests();
      stopWithdrawn();
    };
  }, []);
  const request = requests[0] ?? null;
  const answer = (choice: ScreenShareChoice | null) => {
    if (!request) return;
    setRequests((queue) => queue.filter((entry) => entry.id !== request.id));
    void desktopApi
      .screenShareAnswer({ requestId: request.id, choice })
      .catch(() => {});
  };
  return (
    <Modal
      open={request !== null}
      onClose={() => answer(null)}
      width={680}
      labelledBy="screen-share-title"
    >
      {request && (
        <ScreenSharePicker
          key={request.id}
          request={request}
          onAnswer={answer}
        />
      )}
    </Modal>
  );
}

const KIND_TABS: Array<{
  kind: ScreenShareKind;
  label: string;
  icon: typeof Monitor;
}> = [
  { kind: "tab", label: "Work tab", icon: PanelTop },
  { kind: "window", label: "Window", icon: AppWindow },
  { kind: "screen", label: "Entire screen", icon: Monitor },
];

function ScreenSharePicker({
  request,
  onAnswer,
}: {
  request: ScreenShareRequest;
  onAnswer: (choice: ScreenShareChoice | null) => void;
}) {
  const host = siteHost(request.origin);
  const [sources, setSources] = useState<ScreenShareSources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ScreenShareKind>("tab");
  const [selected, setSelected] = useState<ScreenShareSource | null>(null);
  const [loadingCapture, setLoadingCapture] = useState(true);

  // Tabs are instant; windows and screens can take the OS a few seconds
  // (macOS waits on its capture service), so they land in a second pass.
  useEffect(() => {
    let cancelled = false;
    const guestId = request.guestId;
    void desktopApi
      .screenShareSources({ guestId, kinds: ["tab"] })
      .then((next) => {
        if (cancelled) return;
        setSources((current) => ({ ...(current ?? next), tabs: next.tabs }));
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not list what you can share.");
      });
    setLoadingCapture(true);
    void desktopApi
      .screenShareSources({ guestId, kinds: ["window", "screen"] })
      .then((next) => {
        if (cancelled) return;
        setSources((current) => ({
          tabs: current?.tabs ?? [],
          windows: next.windows,
          screens: next.screens,
          system: next.system,
        }));
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not list what you can share.");
      })
      .finally(() => {
        if (!cancelled) setLoadingCapture(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request.guestId]);

  const switchKind = (next: ScreenShareKind) => {
    if (next === kind) return;
    setKind(next);
    setSelected(null);
  };

  const list = useMemo<ScreenShareSource[]>(() => {
    if (!sources) return [];
    return kind === "tab"
      ? sources.tabs
      : kind === "window"
        ? sources.windows
        : sources.screens;
  }, [sources, kind]);
  const screenDenied = sources?.system === "denied";
  const share = () => {
    if (!selected) return;
    onAnswer({ id: selected.id, kind: selected.kind, name: selected.name });
  };

  return (
    <div
      className="flex max-h-[calc(100dvh-48px)] flex-col p-5"
      data-testid="screen-share-picker"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg-overlay">
          <MonitorUp className="size-4 text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="screen-share-title" className="text-sm font-semibold text-fg">
            Choose what to share
          </h2>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            <span className="font-medium text-fg">{host}</span> will see what
            you pick until you stop sharing.
          </p>
        </div>
        <ShortcutHint label="Cancel" shortcut="Esc">
          <button
            type="button"
            onClick={() => onAnswer(null)}
            aria-label="Cancel sharing"
            className="-mr-1 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </ShortcutHint>
      </div>

      <div
        role="tablist"
        aria-label="Kind of source"
        className="mt-4 grid grid-cols-3 gap-1 rounded-lg bg-bg-inset p-1"
      >
        {KIND_TABS.map((entry) => (
          <ModalTab
            key={entry.kind}
            active={kind === entry.kind}
            onSelect={() => switchKind(entry.kind)}
            icon={<entry.icon className="size-3.5" />}
            label={entry.label}
            testId={`screen-share-kind-${entry.kind}`}
          />
        ))}
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <AnimatedHeight>
          <div key={kind} className="animate-fade-in">
            {screenDenied && kind !== "tab" && (
              <p className="mb-3 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[12px] leading-4 text-warning">
                Work has no Screen Recording access on this Mac, so windows and
                screens show up blank.{" "}
                <button
                  type="button"
                  onClick={() =>
                    void desktopApi.siteSettingsOpenSystemPrivacy({
                      kind: "screen",
                    })
                  }
                  className="cursor-pointer underline decoration-warning/50 underline-offset-2"
                >
                  Open System Settings
                </button>
              </p>
            )}
            {kind === "tab" ? (
              <ul
                className="flex flex-col gap-0.5"
                data-testid="screen-share-tabs"
              >
                {list.map((source) => (
                  <li key={source.id}>
                    <SourceRow
                      source={source}
                      selected={selected?.id === source.id}
                      onSelect={() => setSelected(source)}
                      onCommit={share}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <ul
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                data-testid={`screen-share-${kind}s`}
              >
                {list.map((source) => (
                  <li key={source.id}>
                    <SourceCard
                      source={source}
                      selected={selected?.id === source.id}
                      onSelect={() => setSelected(source)}
                      onCommit={share}
                    />
                  </li>
                ))}
              </ul>
            )}
            {list.length === 0 && (
              <p className="py-10 text-center text-[13px] text-fg-muted">
                {!sources || (kind !== "tab" && loadingCapture)
                  ? (error ?? "Looking for what you can share…")
                  : kind === "tab"
                    ? "No browser tabs to share in this window."
                    : kind === "window"
                      ? "No open windows to share."
                      : "No screens found."}
              </p>
            )}
          </div>
        </AnimatedHeight>
      </div>

      <div className="mt-4 flex items-center gap-3">
        {kind === "tab" && (
          <p className="text-[12px] text-fg-muted">
            A shared tab brings its audio along when the site asks for it.
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAnswer(null)}
            className="button-ghost"
            data-testid="screen-share-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected}
            data-disabled-reason="Pick a tab, window or screen first"
            onClick={share}
            className="button-primary"
            data-testid="screen-share-confirm"
          >
            Share
          </button>
        </div>
      </div>
      {error && sources && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SourceRow({
  source,
  selected,
  onSelect,
  onCommit,
}: {
  source: ScreenShareSource;
  selected: boolean;
  onSelect: () => void;
  onCommit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onCommit}
      aria-pressed={selected}
      data-testid="screen-share-source"
      data-source-id={source.id}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
        selected
          ? "bg-accent/12 text-fg ring-1 ring-accent/50"
          : "text-fg hover:bg-bg-overlay"
      }`}
    >
      {source.thumbnail ? (
        <img
          src={source.thumbnail}
          alt=""
          className="h-12 w-20 shrink-0 rounded border border-border object-cover object-top"
        />
      ) : (
        <span className="grid h-12 w-20 shrink-0 place-items-center rounded border border-border bg-bg-inset">
          <SiteFavicon
            url={source.url ?? ""}
            faviconUrl={source.icon}
            className="size-4"
          />
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <SiteFavicon
          url={source.url ?? ""}
          faviconUrl={source.icon}
          className="size-3.5"
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {source.name}
        </span>
        {source.current && (
          <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-fg-faint">
            This tab
          </span>
        )}
      </span>
    </button>
  );
}

function SourceCard({
  source,
  selected,
  onSelect,
  onCommit,
}: {
  source: ScreenShareSource;
  selected: boolean;
  onSelect: () => void;
  onCommit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onCommit}
      aria-pressed={selected}
      data-testid="screen-share-source"
      data-source-id={source.id}
      className={`flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors duration-150 ${
        selected
          ? "border-accent bg-accent/10"
          : "border-border hover:border-border-strong hover:bg-bg-overlay"
      }`}
    >
      <span className="grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-md bg-bg-inset">
        {source.thumbnail ? (
          <img
            src={source.thumbnail}
            alt=""
            className="size-full object-contain"
          />
        ) : (
          <Monitor className="size-6 text-fg-faint" />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 px-0.5">
        {source.icon ? (
          <img src={source.icon} alt="" className="size-3.5 shrink-0" />
        ) : source.kind === "window" ? (
          <AppWindow className="size-3.5 shrink-0 text-fg-faint" />
        ) : (
          <Monitor className="size-3.5 shrink-0 text-fg-faint" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
          {source.name}
        </span>
      </span>
    </button>
  );
}
