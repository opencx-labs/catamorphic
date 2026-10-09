import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  Globe,
  RotateCw,
  Search,
  Settings,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type BrowserHistory,
  type BrowserSleepBlocker,
  browserHistorySource,
  browserWakeSource,
} from "../../shared/browser-history.js";
import type { HistoryProject } from "../../shared/history.js";
import type { OpenMode } from "../../shared/open-mode.js";
import { siteOrigin } from "../../shared/site-settings.js";
import { AuthorizationInspector } from "../components/authorization-inspector.js";
import {
  ExtensionDebuggingBar,
  ExtensionSidePanelView,
  useExtensionDebugging,
  useExtensionSidePanel,
} from "../components/extensions/extension-side-panel.js";
import { ExtensionToolbar } from "../components/extensions/extension-toolbar.js";
import { FindBar, type FindResult } from "../components/find-bar.js";
import { usePasswordAutofill } from "../components/password-autofill.js";
import {
  type PasswordDraft,
  PasswordEditor,
} from "../components/password-editor.js";
import {
  PasswordPrompt,
  type PasswordPromptState,
} from "../components/password-prompt.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import {
  moveFocusAsApp,
  notePagePress,
  personInputCount,
  personMovedOn,
} from "../lib/app-focus.js";
import {
  type Bookmark,
  type BookmarksData,
  desktopApi,
} from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { pageThemeCss } from "../lib/page-theme.js";
import { pointerMoved } from "../lib/pointer-moved.js";
import { useTheme } from "../lib/theme.js";

/**
 * A browser page inside a workspace tab: address bar (with Chrome-style
 * autocomplete + inline completion) above a <webview> guest. The webview
 * composites into the renderer, so app overlays (chat dock, menus) stack
 * naturally above pages.
 */

interface WebviewElement extends HTMLElement {
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  getTitle: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  reloadIgnoringCache: () => void;
  stop: () => void;
  focus: () => void;
  send: (channel: string, payload: unknown) => void;
  getWebContentsId: () => number;
  getZoomFactor: () => number;
  findInPage: (
    text: string,
    options: { forward?: boolean; findNext?: boolean },
  ) => number;
  stopFindInPage: (
    action: "clearSelection" | "keepSelection" | "activateSelection",
  ) => void;
}

export interface BrowserCommands {
  focusAddress: () => void;
  reload: () => void;
  reloadIgnoringCache: () => void;
  back: () => void;
  forward: () => void;
  /** Opens the page's find bar, or focuses it when open. */
  find: () => void;
  findNext: () => void;
  findPrevious: () => void;
  /** What keeps the page awake, or null when it may sleep (ADR 0194). */
  sleepBlocker: () => Promise<BrowserSleepBlocker | null>;
}

export interface BrowserPageState {
  url: string;
  title: string;
  faviconUrl: string | null;
  /** Present when read: the tab's back and forward list, or null for none. */
  history?: BrowserHistory | null;
}

/** "cnn.com" → https URL; anything not URL-shaped becomes a search. */
export function resolveInput(raw: string): string {
  const input = raw.trim();
  if (/^https?:\/\//i.test(input)) return input;
  // Non-web schemes are still navigations, not searches (data: pages,
  // about:blank, view-source:, file:).
  if (/^(data|about|file|view-source|chrome):/i.test(input)) return input;
  if (
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(input) &&
    !input.includes(" ")
  ) {
    return `https://${input}`;
  }
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(input)) {
    return `http://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

interface Suggestion {
  kind: "search" | "url" | "history";
  label: string;
  detail?: string;
  /** What navigating this suggestion loads. */
  target: string;
}

/** Matches the `tab-in` keyframe duration in styles.css. */
const TAB_OPEN_ANIMATION_MS = 200;

/**
 * Match bookmarks by normalized URL so "example.com" and "example.com/"
 * (or a trailing #fragment) are the same page — otherwise the star reads
 * as unstarred right after starring.
 */
function sameUrl(a: string, b: string): boolean {
  const normalize = (raw: string) => {
    try {
      const url = new URL(raw);
      url.hash = "";
      return url.href.replace(/\/$/, "");
    } catch {
      return raw.replace(/\/$/, "");
    }
  };
  return normalize(a) === normalize(b);
}

export function BrowserScreen({
  profileId,
  projectId,
  projectName,
  initialUrl,
  history,
  surfaceKey,
  active,
  toolbarActive = active,
  visible = active,
  keepAwake = false,
  asleep = false,
  integratedToolbar = false,
  toolbarHost,
  sidebarToolbar = false,
  navigationHost,
  onRevealToolbar,
  onStateChange,
  onPageClose,
  registerNavigate,
  registerHistoryNavigate,
  registerGuest,
  registerCommands,
  onPreviewLink,
  previewLinksWithAlt = true,
  onDismissFloating,
  floatingDismissShortcut,
  onUnsplit,
  onOpenSiteSettings,
  onOpenPasswords,
  onOpenExtensions,
  onOpenUrl,
}: {
  profileId: string;
  /** Null only for a temporary profile browser before its first project. */
  projectId: string | null;
  /** Names the project in the profile's history (ADR 0154). */
  projectName?: string;
  initialUrl: string;
  /**
   * The tab's saved back and forward list (a reopened or restored tab): a
   * fresh guest takes it instead of loading `initialUrl`.
   */
  history?: BrowserHistory;
  /**
   * The tab's workspace key, on its toolbar wherever that renders, so a
   * press there is known to belong to this browser (ADR 0188).
   */
  surfaceKey: string;
  /** This browser tab is the focused workspace tab. */
  active: boolean;
  /** Keep the anchor page's toolbar available behind a floating panel. */
  toolbarActive?: boolean;
  /** On screen at all (focused, or the other pane of a split). */
  visible?: boolean;
  /**
   * Never tell the page it's hidden (agent-driven tabs — the agent works
   * the page regardless of what the user is looking at).
   */
  keepAwake?: boolean;
  /**
   * Unload the page to free its memory (ADR 0194); it loads again, at
   * the same place, when this turns false. A tab that starts asleep loads
   * only once woken.
   */
  asleep?: boolean;
  integratedToolbar?: boolean;
  toolbarHost?: HTMLElement | null;
  sidebarToolbar?: boolean;
  navigationHost?: HTMLElement | null;
  onRevealToolbar?: () => void;
  onStateChange: (state: BrowserPageState) => void;
  /** The page closed itself (`window.close()`); the tab should go too. */
  onPageClose?: () => void;
  /** Set while this tab sits in a split: return it to a full-width tab. */
  onUnsplit?: () => void;
  /** Opens the site settings modal for the page's origin (toolbar gear). */
  onOpenSiteSettings?: (origin: string) => void;
  /** Opens the Passwords page ("Manage passwords"). */
  onOpenPasswords?: () => void;
  /** Opens the Extensions page (ADR 0203). */
  onOpenExtensions?: () => void;
  /** Opens a page in a new tab (the Chrome Web Store from extension UI). */
  onOpenUrl?: (url: string) => void;
  /** Hands the host a navigate(url) for "open in current tab" flows. */
  registerNavigate?: (navigate: (url: string) => void) => void;
  /** Hands the host back/forward navigation for actions and mouse buttons. */
  registerHistoryNavigate?: (
    navigate: (direction: "back" | "forward") => void,
  ) => void;
  /** Reports the webview guest's WebContents id (null when unmounted). */
  registerGuest?: (guestId: number | null) => void;
  registerCommands?: (commands: BrowserCommands | null) => void;
  onPreviewLink?: (url: string, mode: OpenMode) => void;
  previewLinksWithAlt?: boolean;
  onDismissFloating?: () => void;
  floatingDismissShortcut: string;
}) {
  const keybindings = useKeybindings();
  const webviewRef = useRef<WebviewElement | null>(null);
  const onPageCloseRef = useRef(onPageClose);
  onPageCloseRef.current = onPageClose;
  const dismissFloatingRef = useRef(onDismissFloating);
  dismissFloatingRef.current = onDismissFloating;
  const floating = onDismissFloating ? floatingDismissShortcut : "";
  const floatingBindingRef = useRef(floating);
  floatingBindingRef.current = floating;
  useEffect(() => {
    if (guestReadyRef.current)
      webviewRef.current?.send("catamorphic:floating-preview", floating);
  }, [floating]);
  const previewLinksRef = useRef(previewLinksWithAlt);
  previewLinksRef.current = previewLinksWithAlt;
  const onPreviewLinkRef = useRef(onPreviewLink);
  onPreviewLinkRef.current = onPreviewLink;
  useEffect(() => {
    if (guestReadyRef.current)
      webviewRef.current?.send(
        "catamorphic:preview-links-enabled",
        previewLinksWithAlt,
      );
  }, [previewLinksWithAlt]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [partition, setPartition] = useState<string>();
  const [preloadPath, setPreloadPath] = useState<string>();
  // Empty initialUrl = a fresh "New Tab": no webview until the first
  // navigation (src is load-time-only), address bar focused.
  const [firstUrl, setFirstUrl] = useState(initialUrl || null);
  const [pageUrl, setPageUrl] = useState(initialUrl);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A main-frame load failed (DNS, connection, TLS…): the pane shows an
  // error card with a retry instead of sitting silently white forever.
  const [loadError, setLoadError] = useState<{
    url: string;
    description: string;
  } | null>(null);
  // Remount nonce for the <webview>: guest attach is flaky under load
  // (Electron's oldest webview wart) and a crashed/never-attached guest
  // can only be revived by replacing the element.
  const [webviewNonce, setWebviewNonce] = useState(0);
  // A guest with a saved history is created from it (see
  // browserHistorySource) instead of from its URL, so it can still go back.
  // Fixed per guest: a webview navigates whenever its src changes, and the
  // history changes with every page.
  const historyRef = useRef(history);
  historyRef.current = history;
  const [historySource, setHistorySource] = useState(() =>
    history ? browserHistorySource(history) : null,
  );
  const pageUrlRef = useRef(pageUrl);
  pageUrlRef.current = pageUrl;
  // Navigations issued before the guest can accept them (not yet
  // attached / dom-ready) wait here and flush on dom-ready — loadURL on
  // a young webview rejects, and dropping the URL showed the address bar
  // pointing at a page that was never asked to load.
  const pendingUrlRef = useRef<string | null>(null);
  const guestReadyRef = useRef(false);
  const hiddenForGuest = !visible && !keepAwake;
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(initialUrl);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Two-finger history swipe in flight: the arrow at the edge grows with
  // the gesture and fills once it will navigate (Chrome's overscroll cue).
  const [swipe, setSwipe] = useState<{
    direction: "back" | "forward";
    progress: number;
  } | null>(null);
  // The password card keeps its content through the exit motion.
  const [passwordPrompt, setPasswordPrompt] =
    useState<PasswordPromptState | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState<PasswordDraft | null>(
    null,
  );
  const [passwordEditorOpen, setPasswordEditorOpen] = useState(false);
  const pageAreaRef = useRef<HTMLDivElement | null>(null);

  // Find in page, as Chrome's find bar does it. The query stays with the
  // tab for the next opening; a count belongs to the latest request only.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const [findFocus, setFindFocus] = useState(0);
  const findRequestRef = useRef(0);
  const findQueryRef = useRef(findQuery);
  findQueryRef.current = findQuery;
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  /** A new text starts a new search; a step moves through its matches. */
  const search = useCallback((text: string, step?: "next" | "previous") => {
    const view = webviewRef.current;
    if (!view || !guestReadyRef.current) return;
    if (!text) {
      findRequestRef.current = 0;
      setFindResult(null);
      view.stopFindInPage("clearSelection");
      return;
    }
    findRequestRef.current = view.findInPage(
      text,
      step ? { forward: step === "next", findNext: false } : { findNext: true },
    );
  }, []);
  const openFind = useCallback(() => {
    if (!webviewRef.current || !guestReadyRef.current) return;
    // Reopening searches again for the query it kept, as Chrome does; a
    // first opening has none, and leaves the page's selection alone.
    if (!findOpenRef.current && findQueryRef.current)
      search(findQueryRef.current);
    setFindOpen(true);
    setFindFocus((request) => request + 1);
  }, [search]);
  const stepFind = useCallback(
    (direction: "next" | "previous") => {
      if (!findOpenRef.current || !findQueryRef.current) openFind();
      else search(findQueryRef.current, direction);
    },
    [openFind, search],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    findRequestRef.current = 0;
    const view = webviewRef.current;
    if (!view || !guestReadyRef.current) return;
    // The current match stays selected, and the page takes focus back.
    view.stopFindInPage("keepSelection");
    view.focus();
  }, []);
  const findCommandsRef = useRef({ openFind, stepFind });
  findCommandsRef.current = { openFind, stepFind };
  // Find, back and forward reach the page first (see preload/webview.ts),
  // which asks for them as each document starts.
  const pageKeys = useMemo(
    () => ({
      find: keybindings.find,
      "find-next": keybindings["find-next"],
      "find-previous": keybindings["find-previous"],
      "browser-back": keybindings["browser-back"],
      "browser-forward": keybindings["browser-forward"],
    }),
    [
      keybindings.find,
      keybindings["find-next"],
      keybindings["find-previous"],
      keybindings["browser-back"],
      keybindings["browser-forward"],
    ],
  );
  const pageKeysRef = useRef(pageKeys);
  pageKeysRef.current = pageKeys;
  useEffect(() => {
    if (guestReadyRef.current)
      webviewRef.current?.send("catamorphic:page-keys", pageKeys);
  }, [pageKeys]);
  // Selected text and find matches take the theme's accent (lib/page-theme).
  const theme = useTheme();
  const pageCss = theme ? pageThemeCss(theme) : "";
  const pageCssRef = useRef(pageCss);
  pageCssRef.current = pageCss;
  useEffect(() => {
    if (guestReadyRef.current)
      webviewRef.current?.send("catamorphic:page-theme", pageCss);
  }, [pageCss]);
  // Bookmarks for this project+profile, so the star reflects real state
  // (Chrome: filled = saved, click again removes) instead of firing a
  // one-way "add" that silently duplicates on every press.
  const [bookmarks, setBookmarks] = useState<BookmarksData | null>(null);
  const pageTitleRef = useRef("");
  const historyProjectRef = useRef<HistoryProject | undefined>(undefined);
  historyProjectRef.current = projectId
    ? { id: projectId, name: projectName ?? "" }
    : undefined;
  const suggestSeq = useRef(0);
  // Inline completion must only appear while typing forward, never while
  // deleting (Chrome behavior).
  const lastInputLength = useRef(initialUrl.length);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // Session partition + guest preload must exist before mounting the
  // webview (both attributes are load-time-only).
  //
  // Mounting a guest and starting its first paint stalls this thread for
  // ~50ms a few times over. Doing that while the tab-open animation runs
  // made opening a bookmark visibly jaggy (measured: 2–3 stalled frames
  // inside the 200ms animation, every time). Deferring the mount past the
  // animation keeps the open smooth; the load cost then lands on frames
  // where nothing is animating, which is what a real browser does too.
  // A tab opened with no URL has nothing to show and mounts on navigate.
  const [mountReady, setMountReady] = useState(initialUrl === "");
  useEffect(() => {
    if (mountReady) return;
    const timer = setTimeout(() => setMountReady(true), TAB_OPEN_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [mountReady]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const prepare = (attempt: number) => {
      void Promise.all([
        desktopApi.browserPrepareProfile(profileId),
        desktopApi.webviewPreloadPath(),
      ])
        .then(([resolvedPartition, preload]) => {
          if (cancelled) return;
          setPartition(resolvedPartition);
          setPreloadPath(`file://${preload}`);
        })
        .catch((cause: unknown) => {
          // A failed prepare used to strand the tab on a silent spinner
          // forever; main retries the prepare on the next call, so retry.
          console.warn("[browser] profile prepare failed:", cause);
          if (!cancelled && attempt < 3) {
            retryTimer = window.setTimeout(() => prepare(attempt + 1), 800);
          }
        });
    };
    prepare(0);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [profileId]);

  const registerGuestRef = useRef(registerGuest);
  registerGuestRef.current = registerGuest;
  // The page's guest, which extensions know as this tab (ADR 0203).
  const [guestId, setGuestId] = useState<number | null>(null);

  /**
   * Replace the <webview> element with a fresh one pointed at the latest
   * known URL. The only cure for a guest that never attached (silent
   * white tab) or whose renderer died.
   */
  const recoveriesRef = useRef(0);
  const remountWebview = useCallback(() => {
    if (++recoveriesRef.current > 2) {
      setLoading(false);
      setLoadError({
        url: pageUrlRef.current,
        description:
          "This page repeatedly stopped responding. Reload to try again.",
      });
      return;
    }
    guestReadyRef.current = false;
    const target = pendingUrlRef.current ?? pageUrlRef.current ?? null;
    // The replacement keeps the way back unless a navigation was waiting.
    const saved = historyRef.current;
    setHistorySource(
      !pendingUrlRef.current && saved ? browserHistorySource(saved) : null,
    );
    pendingUrlRef.current = null;
    if (target) {
      setFirstUrl(target);
      setPageUrl(target);
    }
    setWebviewNonce((nonce) => nonce + 1);
  }, []);
  const attachWatchdogRef = useRef<number | undefined>(undefined);

  // Asleep, the tab has no guest at all. Main keeps the page's state when
  // it sleeps; the wake builds a fresh guest from it, or from the tab's
  // saved history when there is none.
  const [slept, setSlept] = useState(asleep);
  const wakeSourceRef = useRef<string | null>(null);
  const snapshotRef = useRef<string | null>(null);
  // A tab closed in its sleep never claims what main kept for it.
  useEffect(
    () => () => {
      const snapshotId = snapshotRef.current;
      if (snapshotId) void desktopApi.browserSleepRelease({ snapshotId });
    },
    [],
  );
  useEffect(() => {
    if (!asleep) {
      if (!slept) return;
      recoveriesRef.current = 0;
      guestReadyRef.current = false;
      setLoadError(null);
      const saved = historyRef.current;
      setHistorySource(
        wakeSourceRef.current ?? (saved ? browserHistorySource(saved) : null),
      );
      wakeSourceRef.current = null;
      snapshotRef.current = null;
      if (pageUrlRef.current) setFirstUrl(pageUrlRef.current);
      setWebviewNonce((nonce) => nonce + 1);
      setSlept(false);
      return;
    }
    if (slept) return;
    let cancelled = false;
    let guestId: number | null = null;
    try {
      guestId = guestReadyRef.current
        ? (webviewRef.current?.getWebContentsId() ?? null)
        : null;
    } catch {
      guestId = null;
    }
    void (
      guestId === null
        ? Promise.resolve(null)
        : desktopApi.browserSleep({ guestId }).catch(() => null)
    ).then((snapshot) => {
      if (cancelled) {
        if (snapshot)
          void desktopApi.browserSleepRelease({ snapshotId: snapshot });
        return;
      }
      snapshotRef.current = snapshot;
      const saved = historyRef.current;
      wakeSourceRef.current = snapshot
        ? browserWakeSource(
            snapshot,
            saved ? browserHistorySource(saved) : pageUrlRef.current,
          )
        : null;
      setLoading(false);
      setSlept(true);
    });
    return () => {
      cancelled = true;
    };
  }, [asleep, slept]);

  const guestListenersRef = useRef<AbortController | null>(null);
  const attachWebview = useCallback(
    (node: HTMLElement | null) => {
      guestListenersRef.current?.abort();
      guestListenersRef.current = null;
      const view = node as WebviewElement | null;
      webviewRef.current = view;
      if (!view) {
        window.clearTimeout(attachWatchdogRef.current);
        guestReadyRef.current = false;
        registerGuestRef.current?.(null);
        setGuestId(null);
        // A find belongs to the guest it searched.
        setFindOpen(false);
        setFindResult(null);
        return;
      }
      const listeners = new AbortController();
      guestListenersRef.current = listeners;
      const listen = (name: string, listener: EventListener) =>
        view.addEventListener(name, listener, { signal: listeners.signal });
      // Watchdog: a webview that shows no sign of life (no attach, no
      // load start) within a beat never will — remount it. This is the
      // "type a URL, get a white tab, retry until it works" bug: the
      // failure was silent and unrecoverable in place.
      let alive = false;
      const markAlive = () => {
        alive = true;
        window.clearTimeout(attachWatchdogRef.current);
      };
      listen("did-attach", markAlive);
      listen("did-start-loading", markAlive);
      // A navigation ends any swipe cue, whichever page started it.
      listen("did-start-loading", () => setSwipe(null));
      window.clearTimeout(attachWatchdogRef.current);
      attachWatchdogRef.current = window.setTimeout(() => {
        if (!alive) remountWebview();
      }, 1500);
      // A dead guest renderer leaves a frozen ghost — replace it.
      listen("render-process-gone", () => remountWebview());
      // A page that closes itself (sign-in and payment hand-offs do, once
      // done) leaves a dead guest behind: a blank view that keeps focus
      // and swallows every shortcut, Cmd+W included. Chrome closes the
      // tab; so do we.
      listen("close", () => onPageCloseRef.current?.());
      listen("did-fail-load", ((event: CustomEvent) => {
        const { errorCode, errorDescription, validatedURL, isMainFrame } =
          event as unknown as {
            errorCode: number;
            errorDescription: string;
            validatedURL: string;
            isMainFrame: boolean;
          };
        // -3 = ERR_ABORTED: a superseded navigation, not a failure.
        if (!isMainFrame || errorCode === -3) return;
        setLoading(false);
        setLoadError({
          url: validatedURL || pageUrlRef.current,
          description: errorDescription || `Error ${errorCode}`,
        });
      }) as EventListener);
      listen("dom-ready", () => {
        markAlive();
        guestReadyRef.current = true;
        try {
          const id = view.getWebContentsId();
          registerGuestRef.current?.(id);
          setGuestId(id);
        } catch {
          // Guest detached between events; the next dom-ready re-reports.
        }
        // Hidden-tab power hygiene: the page learns its real visibility
        // (see preload/webview.ts) — parked tabs stop playing video and
        // polling at full rate, like Chrome background tabs.
        try {
          view.send(
            "catamorphic:preview-links-enabled",
            previewLinksRef.current,
          );
          view.send("catamorphic:floating-preview", floatingBindingRef.current);
          view.send("catamorphic:page-keys", pageKeysRef.current);
          view.send("catamorphic:page-theme", pageCssRef.current);
        } catch {
          // Guest gone mid-call; the next dom-ready re-sends.
        }
        // Navigations that arrived while the guest couldn't take them.
        const pending = pendingUrlRef.current;
        if (pending) {
          pendingUrlRef.current = null;
          void view.loadURL(pending).catch(() => {
            pendingUrlRef.current = pending;
          });
        }
      });
      listen("ipc-message", ((event: CustomEvent) => {
        const message = event as unknown as {
          channel: string;
          args: unknown[];
        };
        if (message.channel === "catamorphic:open-link") {
          const link = message.args[0];
          if (
            link &&
            typeof link === "object" &&
            "url" in link &&
            "mode" in link &&
            typeof link.url === "string" &&
            /^https?:\/\//i.test(link.url) &&
            (link.mode === "tab" ||
              link.mode === "side" ||
              (link.mode === "floating" && previewLinksRef.current))
          )
            onPreviewLinkRef.current?.(link.url, link.mode);
          return;
        }
        if (autofillMessageRef.current(message.channel, message.args)) return;
        if (message.channel === "catamorphic:page-press") {
          notePagePress();
          return;
        }
        if (message.channel === "catamorphic:dismiss-floating") {
          dismissFloatingRef.current?.();
          return;
        }
        if (message.channel === "catamorphic:page-keys-wanted") {
          try {
            view.send("catamorphic:page-keys", pageKeysRef.current);
          } catch {
            // Guest gone mid-call; its dom-ready re-sends.
          }
          return;
        }
        if (message.channel === "catamorphic:page-key") {
          const action = message.args[0];
          if (action === "find") findCommandsRef.current.openFind();
          if (action === "find-next") findCommandsRef.current.stepFind("next");
          if (action === "find-previous")
            findCommandsRef.current.stepFind("previous");
          if (action === "browser-back" && view.canGoBack()) view.goBack();
          if (action === "browser-forward" && view.canGoForward())
            view.goForward();
          return;
        }
        if (message.channel === "catamorphic:browser-swipe") {
          const payload = message.args[0] as {
            direction: "back" | "forward" | null;
            progress: number;
          };
          setSwipe(
            payload.direction &&
              (payload.direction === "back"
                ? view.canGoBack()
                : view.canGoForward())
              ? { direction: payload.direction, progress: payload.progress }
              : null,
          );
          return;
        }
        if (message.channel !== "catamorphic:browser-mouse-history") return;
        const payload = message.args[0];
        const direction =
          payload && typeof payload === "object" && "direction" in payload
            ? payload.direction
            : undefined;
        if (direction === "back" && view.canGoBack()) view.goBack();
        if (direction === "forward" && view.canGoForward()) view.goForward();
      }) as EventListener);

      const sync = () => {
        setCanGoBack(view.canGoBack());
        setCanGoForward(view.canGoForward());
      };
      const report = (patch: Partial<BrowserPageState>) => {
        onStateChangeRef.current({
          url: view.getURL(),
          title: view.getTitle(),
          faviconUrl: null,
          ...patch,
        });
      };
      // The back and forward list, read a beat after the page settles, so
      // closing the tab (or the app) keeps the way back.
      let historyTimer: number | undefined;
      const readHistory = () => {
        window.clearTimeout(historyTimer);
        historyTimer = window.setTimeout(() => {
          let guestId: number;
          try {
            guestId = view.getWebContentsId();
          } catch {
            return;
          }
          void desktopApi
            .browserNavigationHistory({ guestId })
            .then((read) => {
              if (!listeners.signal.aborted) report({ history: read });
            })
            .catch(() => {});
        }, 300);
      };
      listeners.signal.addEventListener("abort", () =>
        window.clearTimeout(historyTimer),
      );

      listen("did-start-loading", () => {
        setLoading(true);
        setLoadError(null);
      });
      listen("did-stop-loading", () => setLoading(false));
      listen("found-in-page", ((event: CustomEvent) => {
        const { result } = event as unknown as {
          result: {
            requestId: number;
            activeMatchOrdinal: number;
            matches: number;
          };
        };
        if (result.requestId !== findRequestRef.current) return;
        setFindResult({
          active: result.activeMatchOrdinal,
          matches: result.matches,
        });
      }) as EventListener);
      listen("did-navigate", ((event: CustomEvent) => {
        const { url } = event as unknown as { url: string };
        // Another page ends the find, as in Chrome; the query stays.
        setFindOpen(false);
        setFindResult(null);
        findRequestRef.current = 0;
        setPageUrl(url);
        setInputValue(url);
        // A save offer rides out the sign-in's redirects (a login on
        // accounts.example.com lands on app.example.com); the user's
        // own navigation from the address bar dismisses it.
        closeAutofillRef.current();
        sync();
        report({ url });
        readHistory();
        void desktopApi.browserRecordHistory({
          url,
          title: view.getTitle() || url,
          project: historyProjectRef.current,
        });
      }) as EventListener);
      listen("did-navigate-in-page", ((event: CustomEvent) => {
        const { url, isMainFrame } = event as unknown as {
          url: string;
          isMainFrame: boolean;
        };
        if (!isMainFrame) return;
        setPageUrl(url);
        setInputValue(url);
        sync();
        report({ url });
        readHistory();
        void desktopApi.browserRecordHistory({
          url,
          title: view.getTitle() || url,
          project: historyProjectRef.current,
        });
      }) as EventListener);
      listen("page-title-updated", ((event: CustomEvent) => {
        const { title } = event as unknown as { title: string };
        pageTitleRef.current = title;
        report({ title });
        readHistory();
        void desktopApi.browserRetitleHistory({
          url: view.getURL(),
          title,
        });
      }) as EventListener);
      listen("page-favicon-updated", ((event: CustomEvent) => {
        const { favicons } = event as unknown as { favicons: string[] };
        const nextFavicon = favicons[0] ?? null;
        setFaviconUrl(nextFavicon);
        report({ faviconUrl: nextFavicon });
        if (nextFavicon) {
          void desktopApi.browserSetHistoryFavicon({
            url: view.getURL(),
            faviconUrl: nextFavicon,
          });
        }
      }) as EventListener);
    },
    [remountWebview],
  );

  useEffect(() => {
    const ownGuest = (guestId: number) => {
      try {
        return webviewRef.current?.getWebContentsId() === guestId;
      } catch {
        return false;
      }
    };
    const stopOffer = desktopApi.onBrowserCredentialSaveOffer((offer) => {
      if (!ownGuest(offer.guestId)) return;
      setPasswordPrompt({ kind: "offer", offer });
      setPasswordPromptOpen(true);
    });
    const stopSaved = desktopApi.onBrowserCredentialSaved((saved) => {
      if (!ownGuest(saved.guestId)) return;
      setPasswordPrompt({
        kind: "saved",
        origin: saved.origin,
        credential: saved.credential,
      });
      setPasswordPromptOpen(true);
    });
    return () => {
      stopOffer();
      stopSaved();
    };
  }, []);

  const sidePanel = useExtensionSidePanel(guestId);
  const debugging = useExtensionDebugging(guestId);

  const autofill = usePasswordAutofill({
    profileId,
    guestRef: webviewRef,
    containerRef: pageAreaRef,
    faviconUrl,
    onManage: onOpenPasswords,
  });
  const autofillMessageRef = useRef(autofill.handleGuestMessage);
  autofillMessageRef.current = autofill.handleGuestMessage;
  const closeAutofillRef = useRef(autofill.close);
  closeAutofillRef.current = autofill.close;
  // A hidden tab has no field on screen to suggest under.
  useEffect(() => {
    if (!visible) autofill.close();
  }, [visible, autofill.close]);

  const dismissPasswordPrompt = useCallback(() => {
    setPasswordPromptOpen(false);
    setPasswordPrompt((prompt) => {
      if (prompt?.kind === "offer")
        void desktopApi.browserCredentialDismiss({
          pendingId: prompt.offer.pendingId,
        });
      return prompt;
    });
  }, []);

  const savePasswordOffer = async () => {
    if (passwordPrompt?.kind !== "offer") return;
    await desktopApi.browserCredentialAccept({
      profileId,
      pendingId: passwordPrompt.offer.pendingId,
    });
    setPasswordPromptOpen(false);
  };

  const neverSavePasswords = () => {
    if (passwordPrompt?.kind !== "offer") return;
    void desktopApi.browserCredentialNever({
      profileId,
      pendingId: passwordPrompt.offer.pendingId,
    });
    setPasswordPromptOpen(false);
  };

  const updateSavedPassword = async () => {
    if (passwordPrompt?.kind !== "saved") return;
    const { credential } = passwordPrompt;
    // A generated password can land on a login that already had a note;
    // the editor must show it rather than save over it.
    const revealed = credential.hasNote
      ? await desktopApi.vaultReveal({ profileId, id: credential.id })
      : null;
    if (credential.hasNote && !revealed) return;
    setPasswordDraft({
      id: credential.id,
      origin: credential.origin,
      username: credential.username,
      note: revealed?.note ?? "",
    });
    setPasswordEditorOpen(true);
    setPasswordPromptOpen(false);
  };

  const navigate = useCallback(
    (raw: string) => {
      if (!raw.trim()) return;
      // Chrome's address for its extensions page opens Work's.
      if (/^chrome:\/\/extensions\/?$/i.test(raw.trim()) && onOpenExtensions) {
        setEditing(false);
        setSuggestions([]);
        setInputValue(pageUrl);
        onOpenExtensions();
        return;
      }
      const url = resolveInput(raw);
      recoveriesRef.current = 0;
      setEditing(false);
      setSuggestions([]);
      setPageUrl(url);
      setInputValue(url);
      setLoadError(null);
      // Going somewhere else answers an open save offer with "not now".
      dismissPasswordPrompt();
      if (firstUrl === null) {
        setFirstUrl(url);
        return;
      }
      // A guest that can't take the navigation yet (mount deferred past
      // the tab animation, attach pending) must not eat it: queue and
      // flush on dom-ready. loadURL also REJECTS on a young webview —
      // requeue instead of `void`-swallowing (the old behavior behind
      // "the address bar says linkedin.com but the page is white").
      const view = webviewRef.current;
      if (!view || !guestReadyRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      void view.loadURL(url).catch(() => {
        pendingUrlRef.current = url;
      });
      view.focus();
    },
    [firstUrl, dismissPasswordPrompt, onOpenExtensions, pageUrl],
  );

  const registerNavigateRef = useRef(registerNavigate);
  registerNavigateRef.current = registerNavigate;
  useEffect(() => {
    registerNavigateRef.current?.(navigate);
  }, [navigate]);

  const revealToolbarRef = useRef(onRevealToolbar);
  revealToolbarRef.current = onRevealToolbar;
  // Cmd+L from the app (renderer keydown) and from inside page content
  // (forwarded by main via before-input-event on the guest).
  const focusAddress = useCallback(
    ({ greetingSince }: { greetingSince?: number | null } = {}) => {
      const input = inputRef.current;
      if (!input) return;
      const greeting = greetingSince !== undefined;
      const focus = () => {
        // A greeting answers what brought the tab forward: not once the
        // person has acted since, even a frame later. It is the app's own
        // move, so a chat about to focus its composer keeps doing so.
        if (greeting && personMovedOn(greetingSince ?? null)) return;
        setEditing(true);
        const move = () => {
          input.focus();
          input.select();
        };
        if (greeting) moveFocusAsApp(move);
        else move();
      };
      if (sidebarToolbar) {
        revealToolbarRef.current?.();
        requestAnimationFrame(focus);
      } else focus();
    },
    [sidebarToolbar],
  );

  // Chrome reloads: Cmd+R, Cmd+Shift+R (hard, cache-ignoring).
  const reload = useCallback((hard: boolean) => {
    recoveriesRef.current = 0;
    const view = webviewRef.current;
    if (!view) return;
    if (hard) view.reloadIgnoringCache();
    else view.reload();
  }, []);

  const registerCommandsRef = useRef(registerCommands);
  registerCommandsRef.current = registerCommands;
  const navigateHistory = useCallback((direction: "back" | "forward") => {
    const view = webviewRef.current;
    if (!view) return;
    if (direction === "back" && view.canGoBack()) view.goBack();
    if (direction === "forward" && view.canGoForward()) view.goForward();
  }, []);

  const registerHistoryNavigateRef = useRef(registerHistoryNavigate);
  registerHistoryNavigateRef.current = registerHistoryNavigate;
  useEffect(() => {
    registerHistoryNavigateRef.current?.(navigateHistory);
  }, [navigateHistory]);

  useEffect(() => {
    return desktopApi.onBrowserNavigate((command) => {
      const view = webviewRef.current;
      if (!view) return;
      if (
        command.webContentsId !== null &&
        view.getWebContentsId() !== command.webContentsId
      ) {
        return;
      }
      // A press outside any page is the workspace's to route (ADR 0188).
      if (command.webContentsId === null) return;
      navigateHistory(command.direction);
    });
  }, [navigateHistory]);

  useEffect(() => {
    registerCommandsRef.current?.({
      focusAddress,
      reload: () => reload(false),
      reloadIgnoringCache: () => reload(true),
      back: () => {
        const view = webviewRef.current;
        if (view?.canGoBack()) view.goBack();
      },
      forward: () => {
        const view = webviewRef.current;
        if (view?.canGoForward()) view.goForward();
      },
      find: openFind,
      findNext: () => stepFind("next"),
      findPrevious: () => stepFind("previous"),
      sleepBlocker: async () => {
        const view = webviewRef.current;
        if (!view || !guestReadyRef.current) return null;
        try {
          return await desktopApi.browserSleepBlocker({
            guestId: view.getWebContentsId(),
          });
        } catch {
          return null;
        }
      },
    });
    return () => registerCommandsRef.current?.(null);
  }, [focusAddress, reload, openFind, stepFind]);

  // A fresh New Tab greets with the address bar focused (Chrome behavior);
  // a page takes focus as its tab comes forward. Both answer what brought
  // the tab forward, so neither happens once the person has done something
  // since (opened a chat over it, say), and both are the app's own moves.
  const cameForwardAt = useRef<number | null>(null);
  if (!active) cameForwardAt.current = null;
  else cameForwardAt.current ??= personInputCount();
  const firstUrlRef = useRef(firstUrl);
  firstUrlRef.current = firstUrl;
  useEffect(() => {
    if (!active || personMovedOn(cameForwardAt.current)) return;
    if (firstUrlRef.current === null)
      focusAddress({ greetingSince: cameForwardAt.current });
    else moveFocusAsApp(() => webviewRef.current?.focus());
  }, [active, focusAddress]);
  // A New Tab's first address hands focus to its page, as Enter does.
  const hadUrl = useRef(firstUrl !== null);
  useEffect(() => {
    if (firstUrl === null || hadUrl.current) return;
    hadUrl.current = true;
    if (active) webviewRef.current?.focus();
  }, [firstUrl, active]);

  // Follow bookmark changes from anywhere (this star, another tab's star,
  // the sidebar's delete/pin) so the star never drifts from the sidebar.
  useEffect(() => {
    if (!projectId) {
      setBookmarks(null);
      return;
    }
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((loaded) => {
      if (!cancelled) setBookmarks(loaded);
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      if (change.projectId === projectId && change.project) {
        setBookmarks({
          project: change.project,
          pinned: change.pinned,
          library: change.library,
        });
      } else if (change.projectId === null) {
        // Profile-wide changes include the saved library and explicit pins.
        setBookmarks((current) =>
          current
            ? { ...current, pinned: change.pinned, library: change.library }
            : current,
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  // The saved entry for the current page, if any — pinned bookmarks count
  // too, so starring a pinned page doesn't create a project duplicate.
  const currentBookmark:
    | (Bookmark & { pinned: boolean; library?: boolean })
    | undefined = (() => {
    if (!bookmarks) return undefined;
    const pinned = bookmarks.pinned.bookmarks.find((entry) =>
      sameUrl(entry.url, pageUrl),
    );
    if (pinned) return { ...pinned, pinned: true };
    const owned = bookmarks.project.bookmarks.find((entry) =>
      sameUrl(entry.url, pageUrl),
    );
    if (owned) return { ...owned, pinned: false };
    const saved = bookmarks.library?.bookmarks.find((entry) =>
      sameUrl(entry.url, pageUrl),
    );
    return saved ? { ...saved, pinned: false, library: true } : undefined;
  })();

  const toggleBookmark = () => {
    if (!projectId) return;
    // A broken bookmarks file refuses changes; Settings names it, and the
    // star keeps showing what the file holds.
    const ignore = () => {};
    if (!currentBookmark) {
      desktopApi
        .bookmarksAdd({
          projectId,
          profileId,
          label: pageTitleRef.current || pageUrl,
          url: pageUrl,
          faviconUrl: faviconUrl ?? undefined,
        })
        .catch(ignore);
      return;
    }
    (currentBookmark.library
      ? desktopApi.bookmarksRemoveLibrary({
          projectId,
          profileId,
          id: currentBookmark.id,
        })
      : currentBookmark.pinned
        ? desktopApi.bookmarksRemovePinned({
            projectId,
            profileId,
            id: currentBookmark.id,
          })
        : desktopApi.bookmarksRemove({
            projectId,
            profileId,
            id: currentBookmark.id,
          })
    ).catch(ignore);
  };

  const updateSuggestions = useCallback(
    async (query: string, typedForward: boolean) => {
      const seq = ++suggestSeq.current;
      const trimmed = query.trim();
      if (!trimmed) {
        setSuggestions([]);
        return;
      }
      const { matches, inline } = await desktopApi.browserSuggest({
        profileId,
        query: trimmed,
      });
      if (seq !== suggestSeq.current) return;

      const urlish =
        /^[\w-]+(\.[\w-]+)+/.test(trimmed) ||
        /^https?:/i.test(trimmed) ||
        /^localhost(:\d+)?(\/|$)/i.test(trimmed);
      const first: Suggestion = urlish
        ? { kind: "url", label: trimmed, target: trimmed }
        : {
            kind: "search",
            label: trimmed,
            detail: "Google Search",
            target: trimmed,
          };
      const history: Suggestion[] = matches
        .filter((match) => match.url !== resolveInput(trimmed))
        .map((match) => ({
          kind: "history" as const,
          label: match.title,
          detail: match.url.replace(/^https?:\/\/(www\.)?/, ""),
          target: match.url,
        }));
      setSuggestions([first, ...history].slice(0, 6));
      setSelectedIndex(0);

      // Chrome-style inline completion: complete the bare host in place,
      // selecting the appended span, only while typing forward. Applied
      // synchronously on the DOM (value + selection in one tick) — going
      // through async state + RAF leaves a window where the next keystroke
      // lands after the completion but before the selection, corrupting
      // the input ("exa" → "example.com/a").
      const input = inputRef.current;
      if (
        typedForward &&
        inline &&
        input &&
        input.value.trim() === trimmed &&
        inline.toLowerCase().startsWith(trimmed.toLowerCase()) &&
        inline.length > trimmed.length
      ) {
        input.value = inline;
        input.setSelectionRange(trimmed.length, inline.length);
        setInputValue(inline);
      }
    },
    [profileId],
  );

  const commitSuggestion = (suggestion: Suggestion) => {
    navigate(suggestion.target);
  };

  const displayValue = editing
    ? inputValue
    : pageUrl.replace(/^https?:\/\/(www\.)?/, "");

  const showSuggestions = editing && suggestions.length > 0;

  const ready =
    partition !== undefined && preloadPath !== undefined && mountReady;

  const suggestionRow = (suggestion: Suggestion, index: number) => (
    <button
      key={`${suggestion.kind}:${suggestion.target}`}
      type="button"
      // mousedown so the input's blur doesn't dismiss the row first.
      onMouseDown={(event) => {
        event.preventDefault();
        commitSuggestion(suggestion);
      }}
      onMouseMove={(event) => {
        if (pointerMoved(event)) setSelectedIndex(index);
      }}
      className={`flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] ${
        index === selectedIndex ? "bg-bg-raised text-fg" : "text-fg-muted"
      }`}
    >
      {suggestion.kind === "search" ? (
        <Search className="size-3.5 shrink-0 text-fg-faint" />
      ) : (
        <Globe className="size-3.5 shrink-0 text-fg-faint" />
      )}
      <span className="truncate">{suggestion.label}</span>
      {suggestion.detail && (
        <span className="truncate text-[12px] text-fg-faint">
          {suggestion.detail}
        </span>
      )}
    </button>
  );

  const navigation = (
    <>
      <ShortcutHint
        label="Back"
        shortcut={formatBinding(keybindings["browser-back"])}
      >
        <button
          type="button"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          data-disabled-reason="No previous page in this tab"
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
      </ShortcutHint>
      <ShortcutHint
        label="Forward"
        shortcut={formatBinding(keybindings["browser-forward"])}
      >
        <button
          type="button"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          data-disabled-reason="No next page in this tab"
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
          aria-label="Forward"
        >
          <ArrowRight className="size-4" />
        </button>
      </ShortcutHint>
      <ShortcutHint label={loading ? "Stop loading" : "Reload"}>
        <button
          type="button"
          onClick={() =>
            loading ? webviewRef.current?.stop() : webviewRef.current?.reload()
          }
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          aria-label={loading ? "Stop" : "Reload"}
        >
          {loading ? (
            <X className="size-4" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
        </button>
      </ShortcutHint>
    </>
  );

  const currentSite = siteOrigin(pageUrl);

  const toolbar = (
    <div
      data-browser-toolbar
      data-surface-key={surfaceKey}
      className={`app-no-drag relative flex min-w-0 shrink-0 items-center gap-1 ${integratedToolbar ? "h-full flex-1" : "h-10 border-b border-border bg-bg px-2"}`}
    >
      {!sidebarToolbar && navigation}

      <div data-address-field className="relative min-w-0 flex-1">
        <input
          ref={inputRef}
          value={displayValue}
          spellCheck={false}
          autoComplete="off"
          aria-label="Address and search bar"
          className={`field h-7 w-full rounded-full px-3.5 text-[13px] ${
            editing ? "text-fg" : "text-fg-muted"
          }`}
          onFocus={(event) => {
            setEditing(true);
            setInputValue(pageUrl);
            lastInputLength.current = pageUrl.length;
            // Chrome selects the full URL on focus, a frame later. select()
            // also focuses, so only while the address bar still has focus
            // (a chat opened in that frame keeps its composer).
            requestAnimationFrame(() => {
              if (document.activeElement === event.target)
                event.target.select();
            });
          }}
          onBlur={() => {
            setEditing(false);
            setSuggestions([]);
          }}
          onChange={(event) => {
            const value = event.target.value;
            const typedForward = value.length > lastInputLength.current;
            lastInputLength.current = value.length;
            setInputValue(value);
            void updateSuggestions(value, typedForward);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const selected = suggestions[selectedIndex];
              if (selected && selected.kind === "history") {
                commitSuggestion(selected);
              } else {
                navigate(inputValue);
              }
            } else if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setSelectedIndex((index) =>
                Math.min(index + 1, suggestions.length - 1),
              );
            } else if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setSelectedIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Escape") {
              setEditing(false);
              setSuggestions([]);
              setInputValue(pageUrl);
              webviewRef.current?.focus();
            }
          }}
        />

        {showSuggestions && (
          <div className="absolute inset-x-0 top-full z-50 mt-1 rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl">
            {suggestions.map(suggestionRow)}
          </div>
        )}
      </div>

      <AuthorizationInspector />

      {/* Bookmark star, Chrome-style: filled means saved, click toggles.
          Bookmarks belong to a project; without one the star says so
          instead of silently doing nothing. */}
      {firstUrl && (
        <ShortcutHint
          label={currentBookmark ? "Remove bookmark" : "Bookmark this page"}
        >
          <button
            type="button"
            onClick={toggleBookmark}
            disabled={!projectId}
            data-disabled-reason="Open a project to keep bookmarks"
            className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent ${
              currentBookmark ? "text-accent" : "text-fg-muted hover:text-fg"
            }`}
            aria-label={
              currentBookmark ? "Remove bookmark" : "Bookmark this page"
            }
            aria-pressed={Boolean(currentBookmark)}
          >
            <Star
              className={`size-3.5 transition-[fill,color,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
                currentBookmark ? "scale-110 fill-current" : "scale-100"
              }`}
            />
          </button>
        </ShortcutHint>
      )}
      {/* Site settings gear: permissions and data for this page's site. */}
      {onOpenSiteSettings && currentSite && (
        <ShortcutHint label="Site settings">
          <button
            type="button"
            onClick={() => onOpenSiteSettings(currentSite)}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
            aria-label="Site settings"
            data-testid="site-settings-button"
          >
            <Settings className="size-3.5" />
          </button>
        </ShortcutHint>
      )}
      {onOpenExtensions && onOpenUrl && (
        <ExtensionToolbar
          guestId={guestId}
          partition={partition}
          active={toolbarActive}
          visible={visible || toolbarActive}
          onOpenExtensions={onOpenExtensions}
          onOpenUrl={onOpenUrl}
        />
      )}
      {onUnsplit && (
        <ShortcutHint label="Full width">
          <button
            type="button"
            onClick={onUnsplit}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
            aria-label="Full width"
          >
            <Columns2 className="size-3.5" />
          </button>
        </ShortcutHint>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sidebarToolbar &&
        toolbarActive &&
        navigationHost &&
        createPortal(
          <div className="contents" data-surface-key={surfaceKey}>
            {navigation}
          </div>,
          navigationHost,
        )}
      {integratedToolbar
        ? toolbarActive && toolbarHost && createPortal(toolbar, toolbarHost)
        : toolbar}

      {debugging && <ExtensionDebuggingBar debugging={debugging} />}
      <div className="flex min-h-0 flex-1">
        {/* The theme's background until the page paints its own, as Chrome
          does: a page loading (or a guest mounting) never flashes white. */}
        <div
          ref={pageAreaRef}
          className="relative min-h-0 min-w-0 flex-1 bg-bg"
        >
          {ready && firstUrl && !slept ? (
            <webview
              key={webviewNonce}
              ref={attachWebview}
              src={historySource ?? firstUrl}
              partition={partition}
              preload={preloadPath}
              // Chromium's built-in PDF viewer is exposed as a plugin. Local
              // project PDFs otherwise download or render as raw bytes.
              // Presence attribute, like allowpopups below: React otherwise
              // sets the custom element's boolean property back to false.
              plugins={"" as unknown as boolean}
              // Without allowpopups the guest can't request windows at all
              // and the main-process window-open handler (which reroutes
              // popups into new tabs) never fires.
              // String, not boolean: React warns on a non-boolean attribute
              // and webview reads presence/value, not the DOM property.
              allowpopups={"" as unknown as boolean}
              className="absolute inset-0"
              // Required: webview is display:inline-block by default and
              // collapses to 0×0 inside flex/absolute layouts without this.
              style={{
                width: "100%",
                height: "100%",
                display: hiddenForGuest ? "none" : "flex",
              }}
            />
          ) : firstUrl ? (
            <div className="h-full bg-bg" />
          ) : (
            <div className="grid h-full place-items-center">
              <p className="text-sm text-fg-faint">
                Search or enter an address
              </p>
            </div>
          )}
          {swipe && (
            <div
              aria-hidden="true"
              data-testid="browser-swipe-indicator"
              data-direction={swipe.direction}
              className={`pointer-events-none absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border shadow-lg transition-colors duration-100 ${
                swipe.direction === "back" ? "left-3" : "right-3"
              } ${
                swipe.progress >= 1
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-bg-overlay text-fg"
              }`}
              style={{
                opacity: Math.min(1, 0.35 + swipe.progress * 0.65),
                transform: `translateY(-50%) scale(${0.7 + swipe.progress * 0.3})`,
              }}
            >
              {swipe.direction === "back" ? (
                <ArrowLeft className="size-5" />
              ) : (
                <ArrowRight className="size-5" />
              )}
            </div>
          )}
          {/* Main-frame load failure: a way out instead of a white pane. */}
          {loadError && (
            <div className="absolute inset-0 grid place-items-center bg-bg">
              <div className="max-w-sm text-center">
                <p className="text-sm text-fg">This page didn’t load.</p>
                <p className="mt-1 break-all font-mono text-xs text-fg-muted">
                  {loadError.description}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    recoveriesRef.current = 0;
                    remountWebview();
                  }}
                  className="button-primary button-sm mt-4"
                >
                  <RotateCw className="size-3" />
                  Try again
                </button>
              </div>
            </div>
          )}
          {autofill.overlay}
          {/* The page's own cards at its top right: the find bar above a
            password offer, never over it. */}
          <div className="pointer-events-none absolute right-3 top-3 z-30 flex w-[340px] max-w-[calc(100%-24px)] flex-col items-end gap-2">
            <FindBar
              open={findOpen}
              query={findQuery}
              result={findResult}
              focusRequest={findFocus}
              onQueryChange={(query) => {
                setFindQuery(query);
                search(query);
              }}
              onStep={stepFind}
              onClose={closeFind}
            />
            {passwordPrompt && (
              <PasswordPrompt
                state={passwordPrompt}
                open={passwordPromptOpen}
                onSave={savePasswordOffer}
                onNever={neverSavePasswords}
                onDismiss={dismissPasswordPrompt}
                onUpdate={() => void updateSavedPassword()}
                onExited={() => setPasswordPrompt(null)}
              />
            )}
          </div>
        </div>
        {sidePanel && (
          <ExtensionSidePanelView panel={sidePanel} partition={partition} />
        )}
      </div>
      {passwordDraft && (
        <PasswordEditor
          open={passwordEditorOpen}
          profileId={profileId}
          draft={passwordDraft}
          heading="Edit saved password"
          onClose={() => setPasswordEditorOpen(false)}
        />
      )}
    </div>
  );
}
