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
  desktopApi,
  type SavedCredential,
} from "../lib/desktop-api.js";

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

interface SaveOffer {
  origin: string;
  username: string;
  password: string;
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
  onStateChange,
  registerNavigate,
  onUnsplit,
}: {
  profileId: string;
  projectId: string;
  initialUrl: string;
  /** This browser tab is the focused workspace tab. */
  active: boolean;
  onStateChange: (state: BrowserPageState) => void;
  /** Set while this tab sits in a split: return it to a full-width tab. */
  onUnsplit?: () => void;
  /** Hands the host a navigate(url) for "open in current tab" flows. */
  registerNavigate?: (navigate: (url: string) => void) => void;
}) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [partition, setPartition] = useState<string>();
  const [preloadPath, setPreloadPath] = useState<string>();
  // Empty initialUrl = a fresh "New Tab": no webview until the first
  // navigation (src is load-time-only), address bar focused.
  const [firstUrl, setFirstUrl] = useState(initialUrl || null);
  const [pageUrl, setPageUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(initialUrl);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saveOffer, setSaveOffer] = useState<SaveOffer | null>(null);
  const [fillOffer, setFillOffer] = useState<SavedCredential[] | null>(null);
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
    void Promise.all([
      desktopApi.browserPrepareProfile(profileId),
      desktopApi.webviewPreloadPath(),
    ]).then(([resolvedPartition, preload]) => {
      if (cancelled) return;
      setPartition(resolvedPartition);
      setPreloadPath(`file://${preload}`);
    });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const attachWebview = useCallback(
    (node: HTMLElement | null) => {
      const view = node as WebviewElement | null;
      webviewRef.current = view;
      if (!view) return;

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

      view.addEventListener("did-start-loading", () => setLoading(true));
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
        report({ faviconUrl: favicons[0] ?? null });
      }) as EventListener);

      // Guest preload messages (login form detection, submitted creds).
      view.addEventListener("ipc-message", ((event: CustomEvent) => {
        const { channel, args } = event as unknown as {
          channel: string;
          args: unknown[];
        };
        if (channel === "catamorphic:credentials-submitted") {
          const payload = args[0] as SaveOffer;
          if (payload.password) setSaveOffer(payload);
        } else if (channel === "catamorphic:login-form-detected") {
          const payload = args[0] as { origin: string };
          void desktopApi
            .vaultList({ profileId, origin: payload.origin })
            .then((saved) => {
              if (saved.length > 0) setFillOffer(saved);
            });
        }
      }) as EventListener);
    },
    [profileId],
  );

  const navigate = useCallback(
    (raw: string) => {
      if (!raw.trim()) return;
      const url = resolveInput(raw);
      setEditing(false);
      setSuggestions([]);
      setPageUrl(url);
      setInputValue(url);
      if (firstUrl === null) {
        setFirstUrl(url);
      } else {
        void webviewRef.current?.loadURL(url);
        webviewRef.current?.focus();
      }
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
    const pinned = bookmarks.pinned.find((entry) =>
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
    await desktopApi.vaultSave({ profileId, ...saveOffer });
    setSaveOffer(null);
  };

  const fillCredential = async (credential: SavedCredential) => {
    const revealed = await desktopApi.vaultReveal({
      profileId,
      id: credential.id,
    });
    if (revealed) {
      webviewRef.current?.send("catamorphic:fill-credentials", {
        username: revealed.username,
        password: revealed.password,
      });
    }
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
        <ShortcutHint label="Back">
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
        <ShortcutHint label="Forward">
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
            { label: "Never", onClick: () => setSaveOffer(null) },
          ]}
        />
      )}
      {fillOffer && !saveOffer && (
        <PasswordBar
          icon={<KeyRound className="size-3.5 text-fg-muted" />}
          text="Fill saved password?"
          actions={[
            ...fillOffer.slice(0, 2).map((credential) => ({
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
            ref={attachWebview}
            src={firstUrl}
            partition={partition}
            preload={preloadPath}
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
