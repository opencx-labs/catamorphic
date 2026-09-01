import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  Globe,
  KeyRound,
  RotateCw,
  Search,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ShortcutHint } from "../components/shortcut-hint.js";
import {
  type Bookmark,
  type BookmarksData,
  type BrowserCredentialFillOffer,
  type BrowserCredentialSaveOffer,
  desktopApi,
  type SavedCredential,
} from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";

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
}

export interface BrowserPageState {
  url: string;
  title: string;
  faviconUrl: string | null;
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
  if (input === "localhost" || /^localhost:\d+/.test(input)) {
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
  initialUrl,
  active,
  visible = active,
  keepAwake = false,
  onStateChange,
  registerNavigate,
  registerHistoryNavigate,
  registerGuest,
  onUnsplit,
}: {
  profileId: string;
  projectId: string;
  initialUrl: string;
  /** This browser tab is the focused workspace tab. */
  active: boolean;
  /** On screen at all (focused, or the other pane of a split). */
  visible?: boolean;
  /**
   * Never tell the page it's hidden (agent-driven tabs — the agent works
   * the page regardless of what the user is looking at).
   */
  keepAwake?: boolean;
  onStateChange: (state: BrowserPageState) => void;
  /** Set while this tab sits in a split: return it to a full-width tab. */
  onUnsplit?: () => void;
  /** Hands the host a navigate(url) for "open in current tab" flows. */
  registerNavigate?: (navigate: (url: string) => void) => void;
  /** Hands the host back/forward navigation for actions and mouse buttons. */
  registerHistoryNavigate?: (
    navigate: (direction: "back" | "forward") => void,
  ) => void;
  /** Reports the webview guest's WebContents id (null when unmounted). */
  registerGuest?: (guestId: number | null) => void;
}) {
  const keybindings = useKeybindings();
  const webviewRef = useRef<WebviewElement | null>(null);
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
  const pageUrlRef = useRef(pageUrl);
  pageUrlRef.current = pageUrl;
  // Navigations issued before the guest can accept them (not yet
  // attached / dom-ready) wait here and flush on dom-ready — loadURL on
  // a young webview rejects, and dropping the URL showed the address bar
  // pointing at a page that was never asked to load.
  const pendingUrlRef = useRef<string | null>(null);
  const guestReadyRef = useRef(false);
  // What the guest should believe about its visibility right now.
  const hiddenForGuest = !visible && !keepAwake;
  const hiddenForGuestRef = useRef(hiddenForGuest);
  hiddenForGuestRef.current = hiddenForGuest;
  useEffect(() => {
    const view = webviewRef.current;
    if (!view || !guestReadyRef.current) return;
    try {
      view.send("catamorphic:host-visibility", { hidden: hiddenForGuest });
    } catch {
      // Guest not ready; dom-ready sends the current state.
    }
  }, [hiddenForGuest]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(initialUrl);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saveOffer, setSaveOffer] = useState<BrowserCredentialSaveOffer | null>(
    null,
  );
  const [fillOffer, setFillOffer] = useState<BrowserCredentialFillOffer | null>(
    null,
  );
  // Bookmarks for this project+profile, so the star reflects real state
  // (Chrome: filled = saved, click again removes) instead of firing a
  // one-way "add" that silently duplicates on every press.
  const [bookmarks, setBookmarks] = useState<BookmarksData | null>(null);
  const pageTitleRef = useRef("");
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

  /**
   * Replace the <webview> element with a fresh one pointed at the latest
   * known URL. The only cure for a guest that never attached (silent
   * white tab) or whose renderer died.
   */
  const remountWebview = useCallback(() => {
    guestReadyRef.current = false;
    const target = pendingUrlRef.current ?? pageUrlRef.current ?? null;
    pendingUrlRef.current = null;
    if (target) {
      setFirstUrl(target);
      setPageUrl(target);
    }
    setWebviewNonce((nonce) => nonce + 1);
  }, []);
  const attachWatchdogRef = useRef<number | undefined>(undefined);

  const attachWebview = useCallback(
    (node: HTMLElement | null) => {
      const view = node as WebviewElement | null;
      webviewRef.current = view;
      if (!view) {
        window.clearTimeout(attachWatchdogRef.current);
        guestReadyRef.current = false;
        registerGuestRef.current?.(null);
        return;
      }
      // Watchdog: a webview that shows no sign of life (no attach, no
      // load start) within a beat never will — remount it. This is the
      // "type a URL, get a white tab, retry until it works" bug: the
      // failure was silent and unrecoverable in place.
      let alive = false;
      const markAlive = () => {
        alive = true;
        window.clearTimeout(attachWatchdogRef.current);
      };
      view.addEventListener("did-attach", markAlive);
      view.addEventListener("did-start-loading", markAlive);
      window.clearTimeout(attachWatchdogRef.current);
      attachWatchdogRef.current = window.setTimeout(() => {
        if (!alive) remountWebview();
      }, 1500);
      // A dead guest renderer leaves a frozen ghost — replace it.
      view.addEventListener("render-process-gone", () => remountWebview());
      view.addEventListener("did-fail-load", ((event: CustomEvent) => {
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
      view.addEventListener("dom-ready", () => {
        guestReadyRef.current = true;
        try {
          registerGuestRef.current?.(view.getWebContentsId());
        } catch {
          // Guest detached between events; the next dom-ready re-reports.
        }
        // Hidden-tab power hygiene: the page learns its real visibility
        // (see preload/webview.ts) — parked tabs stop playing video and
        // polling at full rate, like Chrome background tabs.
        try {
          view.send("catamorphic:host-visibility", {
            hidden: hiddenForGuestRef.current,
          });
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
      view.addEventListener("ipc-message", ((event: CustomEvent) => {
        const message = event as unknown as {
          channel: string;
          args: Array<{ direction?: "back" | "forward" }>;
        };
        if (message.channel !== "catamorphic:browser-mouse-history") return;
        const direction = message.args[0]?.direction;
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

      view.addEventListener("did-start-loading", () => {
        setLoading(true);
        setLoadError(null);
      });
      view.addEventListener("did-stop-loading", () => setLoading(false));
      view.addEventListener("did-navigate", ((event: CustomEvent) => {
        const { url } = event as unknown as { url: string };
        setPageUrl(url);
        setInputValue(url);
        // Login submits navigate immediately — that's exactly when the
        // save offer should show (Chrome behavior). Only drop it when
        // the user leaves the site.
        setSaveOffer((offer) =>
          offer && new URL(url).origin === offer.origin ? offer : null,
        );
        setFillOffer(null);
        sync();
        report({ url });
        void desktopApi.browserRecordHistory({
          profileId,
          url,
          title: view.getTitle() || url,
        });
      }) as EventListener);
      view.addEventListener("did-navigate-in-page", ((event: CustomEvent) => {
        const { url, isMainFrame } = event as unknown as {
          url: string;
          isMainFrame: boolean;
        };
        if (!isMainFrame) return;
        setPageUrl(url);
        setInputValue(url);
        sync();
        report({ url });
        void desktopApi.browserRecordHistory({
          profileId,
          url,
          title: view.getTitle() || url,
        });
      }) as EventListener);
      view.addEventListener("page-title-updated", ((event: CustomEvent) => {
        const { title } = event as unknown as { title: string };
        pageTitleRef.current = title;
        report({ title });
        void desktopApi.browserRetitleHistory({
          profileId,
          url: view.getURL(),
          title,
        });
      }) as EventListener);
      view.addEventListener("page-favicon-updated", ((event: CustomEvent) => {
        const { favicons } = event as unknown as { favicons: string[] };
        const nextFavicon = favicons[0] ?? null;
        setFaviconUrl(nextFavicon);
        report({ faviconUrl: nextFavicon });
        if (nextFavicon) {
          void desktopApi.browserSetHistoryFavicon({
            profileId,
            url: view.getURL(),
            faviconUrl: nextFavicon,
          });
        }
      }) as EventListener);
    },
    [profileId, remountWebview],
  );

  useEffect(() => {
    const stopSave = desktopApi.onBrowserCredentialSaveOffer((offer) => {
      if (webviewRef.current?.getWebContentsId() === offer.guestId) {
        setSaveOffer(offer);
      }
    });
    const stopFill = desktopApi.onBrowserCredentialFillOffer((offer) => {
      if (webviewRef.current?.getWebContentsId() === offer.guestId) {
        setFillOffer(offer);
      }
    });
    return () => {
      stopSave();
      stopFill();
    };
  }, []);

  const navigate = useCallback(
    (raw: string) => {
      if (!raw.trim()) return;
      const url = resolveInput(raw);
      setEditing(false);
      setSuggestions([]);
      setPageUrl(url);
      setInputValue(url);
      setLoadError(null);
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
    [firstUrl],
  );

  const registerNavigateRef = useRef(registerNavigate);
  registerNavigateRef.current = registerNavigate;
  useEffect(() => {
    registerNavigateRef.current?.(navigate);
  }, [navigate]);

  // Cmd+L from the app (renderer keydown) and from inside page content
  // (forwarded by main via before-input-event on the guest).
  const focusAddress = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    setEditing(true);
    input.focus();
    input.select();
  }, []);

  // Chrome reloads: Cmd+R, Cmd+Shift+R (hard, cache-ignoring).
  const reload = useCallback((hard: boolean) => {
    const view = webviewRef.current;
    if (!view) return;
    if (hard) view.reloadIgnoringCache();
    else view.reload();
  }, []);

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
      if (command.webContentsId === null && !active) return;
      navigateHistory(command.direction);
    });
  }, [active, navigateHistory]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "l" && !event.shiftKey) {
        event.preventDefault();
        focusAddress();
      } else if (key === "r") {
        event.preventDefault();
        reload(event.shiftKey);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, focusAddress, reload]);

  useEffect(() => {
    if (!active) return;
    return desktopApi.onBrowserFocusAddress((webContentsId) => {
      if (webviewRef.current?.getWebContentsId() === webContentsId) {
        focusAddress();
      }
    });
  }, [active, focusAddress]);

  // Cmd+R pressed while focus is inside this tab's page content arrives
  // via the guest-key relay, addressed by webContentsId.
  useEffect(() => {
    return desktopApi.onBrowserGuestKey((key) => {
      if (!key.meta || key.control || key.alt) return;
      if (key.key.toLowerCase() !== "r") return;
      if (webviewRef.current?.getWebContentsId() === key.webContentsId) {
        reload(key.shift);
      }
    });
  }, [reload]);

  // A fresh New Tab greets with the address bar focused (Chrome behavior).
  useEffect(() => {
    if (active && firstUrl === null) focusAddress();
  }, [active, firstUrl, focusAddress]);

  // Follow bookmark changes from anywhere (this star, another tab's star,
  // the sidebar's delete/pin) so the star never drifts from the sidebar.
  useEffect(() => {
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((loaded) => {
      if (!cancelled) setBookmarks(loaded);
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      if (change.projectId === projectId && change.project) {
        setBookmarks({ project: change.project, pinned: change.pinned });
      } else if (change.projectId === null) {
        // Profile-wide change (e.g. browser import): pinned only.
        setBookmarks((current) =>
          current ? { ...current, pinned: change.pinned } : current,
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
  const currentBookmark: (Bookmark & { pinned: boolean }) | undefined = (() => {
    if (!bookmarks) return undefined;
    const pinned = bookmarks.pinned.bookmarks.find((entry) =>
      sameUrl(entry.url, pageUrl),
    );
    if (pinned) return { ...pinned, pinned: true };
    const owned = bookmarks.project.bookmarks.find((entry) =>
      sameUrl(entry.url, pageUrl),
    );
    return owned ? { ...owned, pinned: false } : undefined;
  })();

  const toggleBookmark = () => {
    if (!currentBookmark) {
      void desktopApi.bookmarksAdd({
        projectId,
        profileId,
        label: pageTitleRef.current || pageUrl,
        url: pageUrl,
        faviconUrl: faviconUrl ?? undefined,
      });
      return;
    }
    void (currentBookmark.pinned
      ? desktopApi.bookmarksRemovePinned({
          projectId,
          profileId,
          id: currentBookmark.id,
        })
      : desktopApi.bookmarksRemove({
          projectId,
          profileId,
          id: currentBookmark.id,
        }));
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
        /^[\w-]+(\.[\w-]+)+/.test(trimmed) || /^https?:/i.test(trimmed);
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

  const saveCredentials = async () => {
    if (!saveOffer) return;
    await desktopApi.browserCredentialAccept({
      profileId,
      pendingId: saveOffer.pendingId,
    });
    setSaveOffer(null);
  };

  const dismissSaveOffer = () => {
    if (saveOffer) {
      void desktopApi.browserCredentialDismiss({
        pendingId: saveOffer.pendingId,
      });
    }
    setSaveOffer(null);
  };

  const fillCredential = async (credential: SavedCredential) => {
    if (!fillOffer) return;
    await desktopApi.browserCredentialFill({
      profileId,
      guestId: fillOffer.guestId,
      credentialId: credential.id,
      formId: fillOffer.formId,
      origin: fillOffer.origin,
    });
    setFillOffer(null);
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
      onMouseEnter={() => setSelectedIndex(index)}
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: back/forward/reload + address bar, scoped to this tab. */}
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
        <ShortcutHint
          label="Back"
          shortcut={formatBinding(keybindings["browser-back"])}
        >
          <button
            type="button"
            onClick={() => webviewRef.current?.goBack()}
            disabled={!canGoBack}
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
              loading
                ? webviewRef.current?.stop()
                : webviewRef.current?.reload()
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

        <div className="relative min-w-0 flex-1">
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
              // Chrome selects the full URL on focus.
              requestAnimationFrame(() => event.target.select());
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

        {/* Bookmark star, Chrome-style: filled means saved, click toggles. */}
        {firstUrl && (
          <ShortcutHint
            label={currentBookmark ? "Remove bookmark" : "Bookmark this page"}
          >
            <button
              type="button"
              onClick={toggleBookmark}
              className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay ${
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

      {/* Password bars: offer-to-save after submit, offer-to-fill on forms. */}
      {saveOffer && (
        <PasswordBar
          icon={<KeyRound className="size-3.5 text-fg-muted" />}
          text={`Save password for ${saveOffer.username || "this site"} on ${new URL(saveOffer.origin).host}?`}
          actions={[
            {
              label: "Save",
              primary: true,
              onClick: () => void saveCredentials(),
            },
            { label: "Not now", onClick: dismissSaveOffer },
          ]}
        />
      )}
      {fillOffer && !saveOffer && (
        <PasswordBar
          icon={<KeyRound className="size-3.5 text-fg-muted" />}
          text="Fill saved password?"
          actions={[
            ...fillOffer.credentials.slice(0, 2).map((credential) => ({
              label: credential.username || "(no username)",
              primary: true,
              onClick: () => void fillCredential(credential),
            })),
            { label: "Dismiss", onClick: () => setFillOffer(null) },
          ]}
        />
      )}

      {/* Stay on the app background until the guest actually mounts —
          flashing white for the pre-mount frames is its own kind of jank. */}
      <div
        className={`relative min-h-0 flex-1 ${
          ready && firstUrl ? "bg-white" : "bg-bg"
        }`}
      >
        {ready && firstUrl ? (
          <webview
            key={webviewNonce}
            ref={attachWebview}
            src={firstUrl}
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
            style={{ width: "100%", height: "100%" }}
          />
        ) : firstUrl ? (
          <div className="h-full bg-bg" />
        ) : (
          <div className="grid h-full place-items-center">
            <p className="text-sm text-fg-faint">Search or enter an address</p>
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
                onClick={() => navigate(loadError.url)}
                className="mt-4 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
              >
                <RotateCw className="size-3" />
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PasswordBar({
  icon,
  text,
  actions,
}: {
  icon: React.ReactNode;
  text: string;
  actions: { label: string; primary?: boolean; onClick: () => void }[];
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-raised px-3">
      {icon}
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">
        {text}
      </span>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          className={`h-6 shrink-0 cursor-pointer rounded-md px-2.5 text-[12px] font-medium transition-colors duration-150 ${
            action.primary
              ? "bg-accent text-accent-fg hover:opacity-90"
              : "text-fg-muted hover:bg-bg-overlay hover:text-fg"
          }`}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
