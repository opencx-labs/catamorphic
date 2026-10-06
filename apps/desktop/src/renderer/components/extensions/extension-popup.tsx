import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { EXTENSION_CHANNELS } from "../../../shared/extensions.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { themeStyle, useTheme } from "../../lib/theme.js";

/** Chrome's popup bounds (extension_popup.cc). */
const MIN_SIZE = 25;
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
const GAP = 6;
const MARGIN = 8;

interface PopupWebview extends HTMLElement {
  getWebContentsId: () => number;
  send: (channel: string, ...args: unknown[]) => void;
  focus: () => void;
  openDevTools: () => void;
}

export interface ExtensionPopupTarget {
  extensionId: string;
  url: string;
  /** The button (or menu) it hangs from. */
  anchor: DOMRect;
}

/**
 * An extension's popup (ADR 0203), hanging under its toolbar button as in
 * Chrome: the page decides its size (Chromium's preferred size, within
 * 25×25 and 800×600), and it closes on Escape, a click elsewhere, focus
 * leaving it, or the page calling `window.close()`.
 */
export function ExtensionPopup({
  target,
  partition,
  tabGuestId,
  onClose,
}: {
  target: ExtensionPopupTarget | null;
  partition: string | undefined;
  tabGuestId: number | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [shown, setShown] = useState<ExtensionPopupTarget | null>(target);
  const [closing, setClosing] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const viewRef = useRef<PopupWebview | null>(null);
  const guestIdRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (target) {
      setShown(target);
      setClosing(false);
      setSize(null);
    } else if (shown) setClosing(true);
  }, [target, shown]);

  // Its page sizes it; until the first size arrives it stays out of sight.
  useEffect(
    () =>
      desktopApi.onExtensionPopupSize((change) => {
        if (change.guestId !== guestIdRef.current) return;
        setSize({
          width: Math.max(MIN_SIZE, Math.min(MAX_WIDTH, change.width)),
          height: Math.max(MIN_SIZE, Math.min(MAX_HEIGHT, change.height)),
        });
      }),
    [],
  );

  const close = useCallback(() => onCloseRef.current(), []);

  // It takes focus once it is shown, as Chrome's does: a hidden element
  // can't hold focus, and its page sizes it only after it is ready.
  const readyRef = useRef(false);
  const shownSize = size !== null;
  const takeFocus = useCallback(() => {
    const view = viewRef.current;
    const guestId = guestIdRef.current;
    if (!view || guestId === null) return;
    view.focus();
    void desktopApi.extensionsFocusPopup({ guestId });
  }, []);
  useEffect(() => {
    if (shownSize && readyRef.current) takeFocus();
  }, [shownSize, takeFocus]);

  useEffect(() => {
    if (!target) return;
    // Inside it, or its own button (which toggles it), keeps it open.
    const keeps = (eventTarget: EventTarget | null) => {
      const element = eventTarget instanceof Element ? eventTarget : null;
      if (!element) return true;
      if (panelRef.current?.contains(element)) return true;
      const button = element.closest('[data-testid="extension-action"]');
      return button?.getAttribute("data-extension-id") === target.extensionId;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!keeps(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // Focus moving to the page (or anywhere else in the app) closes it,
    // however it moved; the popup's own guest reports leaving it.
    const onFocusIn = (event: FocusEvent) => {
      if (!keeps(event.target)) close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    // Armed after this turn: the click that opened it may still be moving
    // focus to its button.
    const timer = window.setTimeout(
      () => document.addEventListener("focusin", onFocusIn, true),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [target, close]);

  const listenersRef = useRef<AbortController | null>(null);
  const attach = useCallback(
    (node: HTMLElement | null) => {
      listenersRef.current?.abort();
      listenersRef.current = null;
      const view = node as PopupWebview | null;
      viewRef.current = view;
      readyRef.current = false;
      if (!view || !shown) return;
      const listeners = new AbortController();
      listenersRef.current = listeners;
      const { signal } = listeners;
      view.addEventListener(
        "dom-ready",
        () => {
          try {
            const guestId = view.getWebContentsId();
            guestIdRef.current = guestId;
            view.send(EXTENSION_CHANNELS.popupMode);
            readyRef.current = true;
            void desktopApi
              .extensionsViewAttached({
                guestId,
                extensionId: shown.extensionId,
                kind: "popup",
                tabGuestId,
              })
              .then(() => {
                if (sizeRef.current) takeFocus();
              });
          } catch {
            // Closed before it was ready.
          }
        },
        { signal },
      );
      view.addEventListener(
        "ipc-message",
        ((event: CustomEvent) => {
          const { channel } = event as unknown as { channel: string };
          if (channel === EXTENSION_CHANNELS.popupClose) close();
        }) as EventListener,
        { signal },
      );
      view.addEventListener("close", close, { signal });
      view.addEventListener("render-process-gone", close, { signal });
    },
    [shown, tabGuestId, close, takeFocus],
  );

  // Placed under the anchor, right edges aligned, kept inside the window.
  const [place, setPlace] = useState<{ left: number; top: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!shown) return;
    const width = size?.width ?? MIN_SIZE;
    const height = size?.height ?? MIN_SIZE;
    const left = Math.max(
      MARGIN,
      Math.min(
        shown.anchor.right - width,
        window.innerWidth - width - MARGIN - 2,
      ),
    );
    const below = shown.anchor.bottom + GAP;
    const top =
      below + height + MARGIN > window.innerHeight
        ? Math.max(MARGIN, window.innerHeight - height - MARGIN - 2)
        : below;
    setPlace({ left, top });
  }, [shown, size]);

  if (!shown || !partition) return null;
  return createPortal(
    <div
      data-theme={theme?.appearance}
      style={{
        ...themeStyle(theme),
        left: place?.left ?? -10_000,
        top: place?.top ?? 0,
        visibility: size ? "visible" : "hidden",
      }}
      className="fixed z-[90]"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Extension"
        data-testid="extension-popup"
        data-extension-id={shown.extensionId}
        onAnimationEnd={(event) => {
          if (event.animationName === "pop-out" && closing) {
            setShown(null);
            setClosing(false);
            guestIdRef.current = null;
          }
        }}
        className={`origin-top-right overflow-hidden rounded-lg border border-border bg-white shadow-2xl ${
          !size
            ? ""
            : closing
              ? "pointer-events-none animate-pop-out"
              : "animate-pop-in"
        }`}
      >
        <webview
          key={`${shown.extensionId} ${shown.url}`}
          ref={attach}
          src={shown.url}
          partition={partition}
          webpreferences="enablePreferredSizeMode=yes"
          allowpopups={"" as unknown as boolean}
          style={{
            display: "flex",
            width: size?.width ?? MIN_SIZE,
            height: size?.height ?? MIN_SIZE,
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
