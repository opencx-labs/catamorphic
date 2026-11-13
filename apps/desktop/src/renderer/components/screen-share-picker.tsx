import { AppWindow, Monitor, MonitorUp, PanelTop, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ScreenShareCaptureSources,
  ScreenShareChoice,
  ScreenShareKind,
  ScreenShareRequest,
  ScreenShareSource,
  SystemScreenAccess,
} from "../../shared/screen-share.js";
import { siteHost } from "../../shared/site-settings.js";
import { desktopApi } from "../lib/desktop-api.js";
import type { BrowserEntry } from "../lib/workspace-state.js";
import { Modal } from "./modal.js";
import { ModalTab } from "./modal-tabs.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";

/** The window's tabs, as the share picker needs them. */
export interface ScreenShareTabsProps {
  /** Every browser tab of the project's workspace, asleep or not. */
  tabs: readonly BrowserEntry[];
  asleep: (localId: string) => boolean;
  /**
   * The tab's page is laid out (on screen, or held for an agent or a
   * share). Only such a page paints, so only it gets a picture: capturing
   * a hidden one can wait forever on macOS.
   */
  laidOut: (localId: string) => boolean;
  /** Each awake tab's page (guest webContents id). */
  guestIds: RefObject<ReadonlyMap<string, number>>;
  /**
   * Holds a tab laid out and awake for the share, waking it if it slept,
   * and resolves with its page once that is ready. The hold lasts until
   * main settles the request, or `letGo` (the answer never reached main);
   * aborting gives up the pick.
   */
  prepareTab: (input: {
    localId: string;
    requestId: string;
    signal: AbortSignal;
  }) => Promise<{ guestId: number; letGo: () => void }>;
}

/**
 * The mounted hosts, one per project the window holds, each saying whether
 * a page is one of its project's. A request goes to the asking page's own
 * project, so one picker answers it, listing that project's tabs.
 */
const hosts = new Set<(guestId: number) => boolean>();

/**
 * Chrome's "Choose what to share" for a page's `getDisplayMedia` call
 * (ADRs 0150, 0315): one of this window's browser tabs (sleeping ones
 * too), an application window, or an entire screen, with the sound that
 * goes along when the page asks for it. Cancel, Escape or a closed tab
 * refuse the request; the page sees NotAllowedError.
 */
export function ScreenShareHost({
  visible,
  ...props
}: ScreenShareTabsProps & {
  /** This project is the one on screen in the window. */
  visible: boolean;
}) {
  const [requests, setRequests] = useState<ScreenShareRequest[]>([]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const { guestIds } = props;
  useEffect(() => {
    const owns = (guestId: number) =>
      [...(guestIds.current?.values() ?? [])].includes(guestId);
    hosts.add(owns);
    const stopRequests = desktopApi.onScreenShareRequest((request) => {
      // A page no project here holds (an extension's panel) asks the
      // project on screen.
      const take =
        owns(request.guestId) ||
        ((visibleRef.current || hosts.size === 1) &&
          ![...hosts].some((other) => other(request.guestId)));
      if (take) setRequests((queue) => [...queue, request]);
    });
    const stopWithdrawn = desktopApi.onScreenShareWithdrawn(({ ids }) =>
      setRequests((queue) =>
        queue.filter((request) => !ids.includes(request.id)),
      ),
    );
    return () => {
      hosts.delete(owns);
      stopRequests();
      stopWithdrawn();
    };
  }, [guestIds]);
  const request = requests[0] ?? null;
  // The answered request stays drawn while the dialog leaves, so the
  // panel fades out with its content rather than collapsing first.
  const shownRef = useRef(request);
  if (request) shownRef.current = request;
  const shown = request ?? shownRef.current;
  const cancelRef = useRef<(() => void) | null>(null);
  const answer = useCallback(
    (
      requestId: string,
      choice: ScreenShareChoice | null,
      letGo?: () => void,
    ) => {
      setRequests((queue) => queue.filter((entry) => entry.id !== requestId));
      void desktopApi
        .screenShareAnswer({ requestId, choice })
        .catch(() => false)
        .then((delivered) => {
          // The page stopped asking meanwhile: the tab is not shared.
          if (!delivered) letGo?.();
        });
    },
    [],
  );
  return (
    <Modal
      open={request !== null}
      onClose={() => {
        if (cancelRef.current) cancelRef.current();
        else if (request) answer(request.id, null);
      }}
      width={680}
      labelledBy="screen-share-title"
    >
      {shown && (
        <ScreenSharePicker
          key={shown.id}
          {...props}
          request={shown}
          closing={request === null}
          cancelRef={cancelRef}
          onAnswer={(choice, letGo) => answer(shown.id, choice, letGo)}
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

/** One kind of OS source as the picker knows it. */
type CaptureList =
  | { status: "loading" }
  | { status: "ready"; items: ScreenShareSource[]; timedOut: boolean }
  | { status: "failed" };

/** A tab that can be shared, in the window's tab order. */
interface TabSource {
  localId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  asleep: boolean;
  current: boolean;
}

const pageUrl = (entry: BrowserEntry) => entry.url || entry.initialUrl;
const isPage = (url: string) => /^(https?|file):/i.test(url);

function ScreenSharePicker({
  request,
  closing,
  tabs: entries,
  asleep,
  laidOut,
  guestIds,
  prepareTab,
  cancelRef,
  onAnswer,
}: ScreenShareTabsProps & {
  request: ScreenShareRequest;
  /** Answered: the dialog is leaving, nothing here acts any more. */
  closing: boolean;
  cancelRef: RefObject<(() => void) | null>;
  onAnswer: (choice: ScreenShareChoice | null, letGo?: () => void) => void;
}) {
  const host = siteHost(request.origin);
  const [kind, setKind] = useState<ScreenShareKind>("tab");
  // Each kind keeps its own pick, so looking at another kind and coming
  // back finds the same one chosen.
  const [selection, setSelection] = useState<
    Record<ScreenShareKind, string | null>
  >({ tab: null, window: null, screen: null });
  const [audio, setAudio] = useState({ tab: true, screen: false });
  const [screens, setScreens] = useState<CaptureList>({ status: "loading" });
  const [windows, setWindows] = useState<CaptureList>({ status: "loading" });
  const [system, setSystem] = useState<SystemScreenAccess>(null);
  const [systemAudio, setSystemAudio] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<number, string | null>>(
    {},
  );
  const [preparing, setPreparing] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const tabs = useMemo<TabSource[]>(() => {
    const ids = guestIds.current;
    const asker = entries.find(
      (entry) => ids?.get(entry.localId) === request.guestId,
    );
    // Only pages of the asking page's profile and session: an incognito
    // page shares, and is shared with, incognito pages alone.
    return entries
      .filter(
        (entry) =>
          isPage(pageUrl(entry)) &&
          Boolean(entry.incognito) === Boolean(asker?.incognito) &&
          (!asker || entry.profileId === asker.profileId),
      )
      .map((entry) => ({
        localId: entry.localId,
        title: entry.label || entry.title || pageUrl(entry),
        url: pageUrl(entry),
        faviconUrl: entry.faviconUrl,
        asleep: asleep(entry.localId),
        current: entry.localId === asker?.localId,
      }));
  }, [entries, asleep, guestIds, request.guestId]);

  // Pictures of the tabs on screen, once, as the picker opens. A
  // background page paints none, so it shows its icon instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one set of pictures per request
  useEffect(() => {
    let cancelled = false;
    const ids = [...(guestIds.current ?? [])]
      .filter(([localId]) => laidOut(localId))
      .map(([, guestId]) => guestId);
    if (ids.length === 0) return;
    void desktopApi
      .screenShareThumbnails({ guestIds: ids })
      .then((next) => {
        if (!cancelled) setThumbnails(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Screens arrive quickly; macOS can take seconds to list windows. Each
  // fills its own pane as it comes, one listing at a time per kind. Asked
  // to try again, an empty list shows it is looking; a quiet refresh (Work
  // focused again) and a list with something in it keep what they show.
  const listing = useRef({ window: false, screen: false });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const listCapture = useCallback(
    (which: "window" | "screen", quiet = false) => {
      if (listing.current[which]) return;
      listing.current[which] = true;
      const set = which === "window" ? setWindows : setScreens;
      set((current) =>
        current.status === "ready" && (quiet || current.items.length > 0)
          ? current
          : { status: "loading" },
      );
      void desktopApi
        .screenShareSources({ kinds: [which] })
        .then((next: ScreenShareCaptureSources) => {
          if (!alive.current) return;
          setSystem(next.system);
          setSystemAudio(next.systemAudio);
          set({
            status: "ready",
            items: which === "window" ? next.windows : next.screens,
            timedOut: next.timedOut,
          });
        })
        .catch(() => {
          if (alive.current) set({ status: "failed" });
        })
        .finally(() => {
          listing.current[which] = false;
        });
    },
    [],
  );
  useEffect(() => {
    listCapture("screen");
    listCapture("window");
  }, [listCapture]);
  // Back from System Settings (Screen Recording), the lists are asked
  // for again.
  useEffect(() => {
    if (system !== "denied") return;
    const refresh = () => {
      listCapture("screen", true);
      listCapture("window", true);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [system, listCapture]);

  // One screen is the obvious pick.
  useEffect(() => {
    const only = screens.status === "ready" ? screens.items : [];
    const [screen] = only;
    if (only.length === 1 && screen)
      setSelection((current) =>
        current.screen ? current : { ...current, screen: screen.id },
      );
  }, [screens]);

  const capture =
    kind === "window" ? windows : kind === "screen" ? screens : null;
  const picked =
    kind === "tab"
      ? tabs.some((tab) => tab.localId === selection.tab)
      : capture?.status === "ready" &&
        capture.items.some((item) => item.id === selection[kind]);
  const offersAudio =
    request.audio && (kind === "tab" || (kind === "screen" && systemAudio));

  // A tab readied for this request and then left (cancel, a closed
  // asking page) gives up its pick, which lets go of the tab.
  const readyingRef = useRef<AbortController | null>(null);
  const answeredRef = useRef(false);
  const closingRef = useRef(closing);
  closingRef.current = closing;
  useEffect(() => {
    if (closing) readyingRef.current?.abort();
  }, [closing]);
  useEffect(() => () => readyingRef.current?.abort(), []);
  const finish = (choice: ScreenShareChoice | null, letGo?: () => void) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onAnswer(choice, letGo);
  };
  const cancel = () => {
    if (answeredRef.current) return;
    readyingRef.current?.abort();
    readyingRef.current = null;
    setPreparing(null);
    finish(null);
  };
  cancelRef.current = closing ? null : cancel;

  /** Shares the pick, or `id` (a double click shares what it lands on). */
  const share = async (id = selection[kind]) => {
    if (closing || preparing || answeredRef.current || !id) return;
    if (kind !== "tab") {
      const source =
        capture?.status === "ready"
          ? capture.items.find((item) => item.id === id)
          : undefined;
      if (!source) return;
      finish({
        id: source.id,
        kind: source.kind,
        name: source.name.slice(0, 4096),
        audio: source.kind === "screen" && offersAudio && audio.screen,
      });
      return;
    }
    const tab = tabs.find((entry) => entry.localId === id);
    if (!tab) return;
    const readying = new AbortController();
    readyingRef.current = readying;
    setPreparing(tab.localId);
    setWaking(tab.asleep);
    setStatus(null);
    try {
      const { guestId, letGo } = await prepareTab({
        localId: tab.localId,
        requestId: request.id,
        signal: readying.signal,
      });
      // Cancelled, or the asking page went away, as the tab became ready.
      if (
        readying.signal.aborted ||
        answeredRef.current ||
        closingRef.current
      ) {
        letGo();
        return;
      }
      readyingRef.current = null;
      finish(
        {
          id: `tab:${guestId}`,
          kind: "tab",
          name: tab.title.slice(0, 4096),
          audio: request.audio && audio.tab,
        },
        letGo,
      );
    } catch (error) {
      if (readying.signal.aborted || answeredRef.current) return;
      readyingRef.current = null;
      setPreparing(null);
      setStatus(
        error instanceof Error ? error.message : "Could not ready that tab.",
      );
    }
  };

  const choose = (id: string) => {
    if (preparing) return;
    setStatus(null);
    setSelection((current) => ({ ...current, [kind]: id }));
  };

  return (
    <div
      className="flex max-h-[calc(100dvh-48px)] flex-col p-5"
      data-testid="screen-share-picker"
      data-closing={closing ? "" : undefined}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg-overlay">
          <MonitorUp className="size-4 text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="screen-share-title" className="text-sm font-semibold text-fg">
            Choose what to share
          </h2>
          <p className="mt-0.5 truncate text-[12px] text-fg-muted">
            <span className="font-medium text-fg">{host}</span> will see what
            you pick until you stop sharing.
          </p>
        </div>
        <ShortcutHint label="Cancel" shortcut="Esc">
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancel sharing"
            className="-mr-1 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </ShortcutHint>
      </div>

      <KindTabs
        kind={kind}
        disabled={preparing !== null}
        onSelect={(next) => {
          setStatus(null);
          setKind(next);
        }}
      />

      <div
        className="mt-3 h-[300px] min-h-0 overflow-y-auto overscroll-contain"
        data-testid="screen-share-body"
      >
        <div key={kind} className="animate-fade-in">
          {kind === "tab" ? (
            <SourceList
              label="Tabs"
              testId="screen-share-tabs"
              layout="rows"
              ids={tabs.map((tab) => tab.localId)}
              selected={selection.tab}
              busy={preparing !== null}
              onChoose={choose}
              onCommit={() => void share()}
            >
              {tabs.length === 0 ? (
                <EmptyPane>No pages to share in this window.</EmptyPane>
              ) : (
                tabs.map((tab, index) => (
                  <TabRow
                    key={tab.localId}
                    tab={tab}
                    index={index}
                    thumbnail={
                      thumbnails[guestIds.current?.get(tab.localId) ?? -1] ??
                      null
                    }
                    selected={selection.tab === tab.localId}
                    focusable={
                      tabs.some((entry) => entry.localId === selection.tab)
                        ? selection.tab === tab.localId
                        : index === 0
                    }
                    preparing={preparing === tab.localId}
                    onChoose={() => choose(tab.localId)}
                    onCommit={() => {
                      choose(tab.localId);
                      void share(tab.localId);
                    }}
                  />
                ))
              )}
            </SourceList>
          ) : (
            <CapturePane
              kind={kind}
              list={capture ?? { status: "loading" }}
              system={system}
              selected={selection[kind]}
              onChoose={choose}
              onCommit={(id) => void share(id)}
              onRetry={() => listCapture(kind)}
            />
          )}
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={`mt-2 h-4 truncate text-xs transition-colors duration-150 ${
          status ? "text-danger" : "text-fg-muted"
        }`}
        data-testid="screen-share-status"
      >
        {status ??
          (preparing
            ? waking
              ? "Waking the tab…"
              : "Getting the tab ready…"
            : "")}
      </p>

      <div className="mt-2 flex min-h-8 items-center gap-3">
        <div key={kind} className="min-w-0 flex-1 animate-fade-in">
          {offersAudio ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={kind === "tab" ? audio.tab : audio.screen}
                disabled={preparing !== null}
                data-disabled-reason="Wait for the tab to be ready"
                onChange={(event) => {
                  const on = event.target.checked;
                  setAudio((current) =>
                    kind === "tab"
                      ? { ...current, tab: on }
                      : { ...current, screen: on },
                  );
                }}
                data-testid="screen-share-audio"
              />
              {kind === "tab"
                ? "Also share tab audio"
                : "Also share system audio"}
            </label>
          ) : request.audio ? (
            <p className="truncate text-[12px] text-fg-muted">
              {kind === "window"
                ? "A window is shared without sound."
                : "A screen is shared without sound on this computer."}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={cancel}
            className="button-ghost"
            data-testid="screen-share-cancel"
          >
            Cancel
          </button>
          <PendingButton
            type="button"
            pending={preparing !== null}
            disabled={!picked}
            data-disabled-reason={
              kind === "tab"
                ? "Pick a tab first"
                : kind === "window"
                  ? "Pick a window first"
                  : "Pick a screen first"
            }
            onClick={() => void share()}
            className="button-primary"
            data-testid="screen-share-confirm"
          >
            Share
          </PendingButton>
        </div>
      </div>
    </div>
  );
}

/** The three kinds, as a tablist the arrow keys move along. */
function KindTabs({
  kind,
  disabled,
  onSelect,
}: {
  kind: ScreenShareKind;
  disabled: boolean;
  onSelect: (kind: ScreenShareKind) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = KIND_TABS.findIndex((entry) => entry.kind === kind);
    const next =
      KIND_TABS[(index + step + KIND_TABS.length) % KIND_TABS.length];
    if (!next) return;
    onSelect(next.kind);
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-testid="screen-share-kind-${next.kind}"]`,
      )
      ?.focus();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Kind of source"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      inert={disabled ? true : undefined}
      className="mt-4 grid grid-cols-3 gap-1 rounded-lg bg-bg-inset p-1"
    >
      {KIND_TABS.map((entry) => (
        <ModalTab
          key={entry.kind}
          active={kind === entry.kind}
          onSelect={() => onSelect(entry.kind)}
          icon={<entry.icon className="size-3.5" />}
          label={entry.label}
          testId={`screen-share-kind-${entry.kind}`}
        />
      ))}
    </div>
  );
}

/**
 * A listbox of sources: the arrow keys move the pick (by row, or across
 * and down a grid), Enter shares the pick, a double click shares at once.
 */
function SourceList({
  label,
  testId,
  layout,
  ids,
  selected,
  busy = false,
  onChoose,
  onCommit,
  children,
}: {
  label: string;
  testId: string;
  layout: "rows" | "grid";
  ids: string[];
  selected: string | null;
  busy?: boolean;
  onChoose: (id: string) => void;
  onCommit: () => void;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || ids.length === 0) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (selected) onCommit();
      return;
    }
    const columns =
      layout === "grid" && listRef.current
        ? getComputedStyle(listRef.current)
            .gridTemplateColumns.split(" ")
            .filter(Boolean).length
        : 1;
    const step =
      event.key === "ArrowDown"
        ? columns
        : event.key === "ArrowUp"
          ? -columns
          : event.key === "ArrowRight" && layout === "grid"
            ? 1
            : event.key === "ArrowLeft" && layout === "grid"
              ? -1
              : event.key === "Home"
                ? -ids.length
                : event.key === "End"
                  ? ids.length
                  : 0;
    if (!step) return;
    event.preventDefault();
    const index = selected ? ids.indexOf(selected) : -1;
    const next =
      ids[
        index === -1
          ? step > 0
            ? 0
            : ids.length - 1
          : Math.max(0, Math.min(ids.length - 1, index + step))
      ];
    if (next === undefined) return;
    onChoose(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-option-id="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: false });
  };
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      aria-busy={busy || undefined}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={
        layout === "rows"
          ? "flex flex-col gap-0.5 p-0.5"
          : "grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3"
      }
    >
      {children}
    </div>
  );
}

/** A picture that fades in once it has decoded, in a box that never moves. */
function Thumbnail({ src, fit }: { src: string; fit: "cover" | "contain" }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt=""
      onLoad={() => setLoaded(true)}
      className={`size-full transition-opacity duration-150 ease-standard ${
        fit === "cover" ? "object-cover object-top" : "object-contain"
      } ${loaded ? "opacity-100" : "opacity-0"}`}
    />
  );
}

function TabRow({
  tab,
  index,
  thumbnail,
  selected,
  focusable,
  preparing,
  onChoose,
  onCommit,
}: {
  tab: TabSource;
  index: number;
  thumbnail: string | null;
  selected: boolean;
  focusable: boolean;
  preparing: boolean;
  onChoose: () => void;
  onCommit: () => void;
}) {
  let address = tab.url;
  try {
    const url = new URL(tab.url);
    address = url.protocol === "file:" ? url.pathname : url.host;
  } catch {}
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      onClick={onChoose}
      onDoubleClick={onCommit}
      onKeyDown={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          onChoose();
        }
      }}
      data-testid="screen-share-source"
      data-option-id={tab.localId}
      data-source-index={index}
      data-asleep={tab.asleep ? "" : undefined}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left focus-ring-inset transition-colors duration-150 ${
        selected
          ? "bg-accent/12 text-fg ring-1 ring-accent/50"
          : "text-fg hover:bg-bg-overlay"
      }`}
    >
      <span className="grid h-12 w-20 shrink-0 place-items-center overflow-hidden rounded border border-border bg-bg-inset">
        {thumbnail ? (
          <Thumbnail src={thumbnail} fit="cover" />
        ) : (
          <SiteFavicon
            url={tab.url}
            faviconUrl={tab.faviconUrl}
            className={`size-4 ${tab.asleep ? "opacity-60" : ""}`}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <SiteFavicon
            url={tab.url}
            faviconUrl={tab.faviconUrl}
            className="size-3.5"
          />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {tab.title}
          </span>
        </span>
        <span className="truncate pl-[22px] text-[11px] text-fg-faint">
          {address}
          {tab.asleep ? " · Asleep, loads when shared" : ""}
        </span>
      </span>
      {preparing ? (
        <span className="shrink-0 text-[11px] text-fg-muted">Loading…</span>
      ) : tab.current ? (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-fg-faint">
          This tab
        </span>
      ) : null}
    </div>
  );
}

function CapturePane({
  kind,
  list,
  system,
  selected,
  onChoose,
  onCommit,
  onRetry,
}: {
  kind: "window" | "screen";
  list: CaptureList;
  system: SystemScreenAccess;
  selected: string | null;
  onChoose: (id: string) => void;
  onCommit: (id?: string) => void;
  onRetry: () => void;
}) {
  const noun = kind === "window" ? "windows" : "screens";
  return (
    <>
      {system === "denied" && (
        <div
          className="mb-3 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[12px] leading-4 text-warning"
          data-testid="screen-share-access"
        >
          Work needs Screen Recording access to share a window or a screen.{" "}
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
          . If you just allowed it, quit and reopen Work.
        </div>
      )}
      {list.status === "loading" ? (
        <ul
          aria-label={`Looking for ${noun}`}
          aria-busy="true"
          className="grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3"
          data-testid="screen-share-loading"
        >
          {Array.from({ length: kind === "window" ? 6 : 2 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
            <li key={index} className="flex flex-col gap-1.5 p-1.5">
              <span className="aspect-[16/10] w-full animate-pulse rounded-md bg-bg-inset" />
              <span className="h-3 w-2/3 animate-pulse rounded bg-bg-inset" />
            </li>
          ))}
        </ul>
      ) : list.status === "failed" ? (
        <EmptyPane>
          Could not list the {noun}. <RetryButton onClick={onRetry} />
        </EmptyPane>
      ) : list.items.length === 0 ? (
        <EmptyPane>
          {system === "denied"
            ? `Your ${noun} show up here once Work may record the screen. `
            : list.timedOut
              ? `Your computer is slow to list its ${noun}. `
              : kind === "window"
                ? "No open windows to share. "
                : "No screens found. "}
          <RetryButton onClick={onRetry} />
        </EmptyPane>
      ) : (
        <SourceList
          label={kind === "window" ? "Windows" : "Screens"}
          testId={`screen-share-${noun}`}
          layout="grid"
          ids={list.items.map((item) => item.id)}
          selected={selected}
          onChoose={onChoose}
          onCommit={() => onCommit()}
        >
          {list.items.map((source, index) => (
            <SourceCard
              key={source.id}
              source={source}
              selected={selected === source.id}
              focusable={
                list.items.some((item) => item.id === selected)
                  ? selected === source.id
                  : index === 0
              }
              onChoose={() => onChoose(source.id)}
              onCommit={() => {
                onChoose(source.id);
                onCommit(source.id);
              }}
            />
          ))}
        </SourceList>
      )}
    </>
  );
}

function SourceCard({
  source,
  selected,
  focusable,
  onChoose,
  onCommit,
}: {
  source: ScreenShareSource;
  selected: boolean;
  focusable: boolean;
  onChoose: () => void;
  onCommit: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      onClick={onChoose}
      onDoubleClick={onCommit}
      onKeyDown={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          onChoose();
        }
      }}
      data-testid="screen-share-source"
      data-option-id={source.id}
      data-source-id={source.id}
      className={`flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 text-left focus-ring-inset transition-colors duration-150 ${
        selected
          ? "border-accent bg-accent/10"
          : "border-border hover:border-border-strong hover:bg-bg-overlay"
      }`}
    >
      <span className="grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-md bg-bg-inset">
        {source.thumbnail ? (
          <Thumbnail src={source.thumbnail} fit="contain" />
        ) : source.kind === "window" ? (
          <AppWindow className="size-6 text-fg-faint" />
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
    </div>
  );
}

function EmptyPane({ children }: { children: ReactNode }) {
  return (
    <p className="py-10 text-center text-[13px] text-fg-muted">{children}</p>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg"
      data-testid="screen-share-retry"
    >
      Try again
    </button>
  );
}
