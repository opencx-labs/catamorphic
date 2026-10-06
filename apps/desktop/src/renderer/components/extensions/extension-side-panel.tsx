import { Puzzle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExtensionDebugging,
  ExtensionSidePanel,
} from "../../../shared/extensions.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { ShortcutHint } from "../shortcut-hint.js";

const WIDTH_KEY = "work.extension-side-panel-width";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 280;

interface PanelWebview extends HTMLElement {
  getWebContentsId: () => number;
}

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** The side panel open beside one tab, kept current from main. */
export function useExtensionSidePanel(
  guestId: number | null,
): ExtensionSidePanel | null {
  const [panel, setPanel] = useState<ExtensionSidePanel | null>(null);
  useEffect(() => {
    if (guestId === null) {
      setPanel(null);
      return;
    }
    let cancelled = false;
    void desktopApi
      .extensionsSidePanels()
      .then((panels) => {
        if (!cancelled)
          setPanel(panels.find((entry) => entry.guestId === guestId) ?? null);
      })
      .catch(() => {});
    const stop = desktopApi.onExtensionSidePanel((change) => {
      if (change.guestId === guestId) setPanel(change.panel);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [guestId]);
  return panel;
}

/**
 * An extension's side panel (ADR 0203), beside the tab it was opened for,
 * as Chrome shows one beside the page: the extension's name and a close
 * button over its page, resizable from its left edge.
 */
export function ExtensionSidePanelView({
  panel,
  partition,
}: {
  panel: ExtensionSidePanel;
  partition: string | undefined;
}) {
  const [width, setWidth] = useState(storedWidth);
  const listenersRef = useRef<AbortController | null>(null);
  const close = useCallback(
    () => void desktopApi.extensionsSidePanelClose({ guestId: panel.guestId }),
    [panel.guestId],
  );
  const attach = useCallback(
    (node: HTMLElement | null) => {
      listenersRef.current?.abort();
      listenersRef.current = null;
      const view = node as PanelWebview | null;
      if (!view) return;
      const listeners = new AbortController();
      listenersRef.current = listeners;
      view.addEventListener(
        "dom-ready",
        () => {
          try {
            void desktopApi.extensionsViewAttached({
              guestId: view.getWebContentsId(),
              extensionId: panel.extensionId,
              kind: "side-panel",
              tabGuestId: panel.guestId,
            });
          } catch {
            // Gone before it was ready.
          }
        },
        { signal: listeners.signal },
      );
      view.addEventListener("close", close, { signal: listeners.signal });
    },
    [panel.extensionId, panel.guestId, close],
  );

  // Dragging the left edge resizes; a window-wide overlay keeps the page
  // and panel webviews from swallowing the moves, as the split divider does.
  const [dragging, setDragging] = useState(false);
  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.6));
    let next = startWidth;
    setDragging(true);
    const move = (moveEvent: MouseEvent) => {
      next = Math.max(
        MIN_WIDTH,
        Math.min(max, startWidth + startX - moveEvent.clientX),
      );
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragging(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        // A remembered width is a convenience.
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!partition) return null;
  return (
    <aside
      data-testid="extension-side-panel"
      data-extension-id={panel.extensionId}
      aria-label={`${panel.name} side panel`}
      style={{ width }}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-bg"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize handle, like the split divider; the panel works at its default width */}
      <div
        data-side-panel-resize
        onMouseDown={startResize}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
        {panel.iconUrl ? (
          <img
            src={panel.iconUrl}
            alt=""
            className="size-4 shrink-0 object-contain"
          />
        ) : (
          <Puzzle className="size-4 shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
          {panel.name}
        </span>
        <ShortcutHint label="Close side panel">
          <button
            type="button"
            onClick={close}
            aria-label="Close side panel"
            data-testid="extension-side-panel-close"
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
        </ShortcutHint>
      </header>
      <div className="relative min-h-0 flex-1 bg-white">
        <webview
          key={panel.url}
          ref={attach}
          src={panel.url}
          partition={partition}
          allowpopups={"" as unknown as boolean}
          className="absolute inset-0"
          style={{ display: "flex", width: "100%", height: "100%" }}
        />
      </div>
    </aside>
  );
}

/** The tab an extension is driving through the page debugger. */
export function useExtensionDebugging(
  guestId: number | null,
): ExtensionDebugging | null {
  const [debugging, setDebugging] = useState<ExtensionDebugging | null>(null);
  useEffect(() => {
    if (guestId === null) {
      setDebugging(null);
      return;
    }
    let cancelled = false;
    void desktopApi
      .extensionsDebugging()
      .then((entries) => {
        if (!cancelled)
          setDebugging(
            entries.find((entry) => entry.guestId === guestId) ?? null,
          );
      })
      .catch(() => {});
    const stop = desktopApi.onExtensionDebuggingChanged((change) => {
      if (change.guestId === guestId) setDebugging(change.debugging);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [guestId]);
  return debugging;
}

/**
 * Chrome's "started debugging this browser" bar, for one tab: who is
 * controlling the page, and a way to stop it.
 */
export function ExtensionDebuggingBar({
  debugging,
}: {
  debugging: ExtensionDebugging;
}) {
  const names = debugging.extensions.map((extension) => extension.name);
  const who =
    names.length <= 1
      ? `“${names[0] ?? "An extension"}”`
      : `${names
          .slice(0, -1)
          .map((name) => `“${name}”`)
          .join(", ")} and “${names.at(-1)}”`;
  return (
    <div
      role="status"
      data-testid="extension-debugging"
      className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-bg-raised px-3 text-[13px] text-fg"
    >
      <span
        className="size-2 shrink-0 rounded-full bg-warning"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">
        {who} {names.length > 1 ? "are" : "is"} controlling this tab
      </span>
      <button
        type="button"
        className="button-secondary button-sm"
        data-testid="extension-debugging-stop"
        onClick={() =>
          void desktopApi.extensionsDebuggerStop({ guestId: debugging.guestId })
        }
      >
        Stop
      </button>
    </div>
  );
}
