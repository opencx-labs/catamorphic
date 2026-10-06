import { MoreHorizontal, Pin, Puzzle, X } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CHROME_WEB_STORE_URL,
  type ExtensionActionState,
  type ExtensionInstalled,
} from "../../../shared/extensions.js";
import { desktopApi } from "../../lib/desktop-api.js";
import {
  badgeTextColor,
  OPEN_EXTENSION_POPUP_EVENT,
  type OpenExtensionPopupDetail,
  useExtensionActions,
} from "../../lib/extensions.js";
import { themeStyle, useTheme } from "../../lib/theme.js";
import { ShortcutHint } from "../shortcut-hint.js";
import {
  ExtensionPopup,
  type ExtensionPopupTarget,
} from "./extension-popup.js";

const INSTALLED_LINGER_MS = 8_000;

/** An extension's icon with its badge, at toolbar size. */
export function ExtensionIcon({
  action,
  size = 16,
}: {
  action: Pick<
    ExtensionActionState,
    "iconUrl" | "name" | "badgeText" | "badgeBackground" | "badgeTextColor"
  >;
  size?: number;
}) {
  return (
    <span
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
    >
      {action.iconUrl ? (
        <img
          src={action.iconUrl}
          alt=""
          draggable={false}
          className="size-full object-contain"
        />
      ) : (
        <Puzzle className="size-full text-fg-muted" />
      )}
      {action.badgeText && (
        <span
          data-testid="extension-badge"
          className="pointer-events-none absolute -bottom-1.5 -right-2 min-w-3.5 rounded-[4px] px-[3px] text-center text-[9px] font-semibold leading-[13px] tabular-nums"
          style={{
            background: action.badgeBackground,
            color:
              action.badgeTextColor ?? badgeTextColor(action.badgeBackground),
          }}
        >
          {action.badgeText.slice(0, 4)}
        </span>
      )}
    </span>
  );
}

/** A popover hanging under a toolbar control, kept inside the window. */
function useAnchoredPlace(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ left: -10_000, top: 0 });
  // Read after the commit: the anchor may mount in the same render.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    setStyle({
      left: Math.max(
        8,
        Math.min(rect.right - width, window.innerWidth - width - 8),
      ),
      top: rect.bottom + 6,
      width,
    });
  }, [anchorRef, open, width]);
  return style;
}

/** A pinned button and the gap after it. */
const PIN_STEP = 32;
const PIN_GAP = 4;
/** What the address field keeps before pins move to the puzzle menu. */
const MIN_ADDRESS_WIDTH = 160;

/**
 * Extensions in a browser tab's toolbar (ADR 0203), as in Chrome: pinned
 * extensions' buttons (badge, popup, right-click menu), then the puzzle
 * button listing every extension of the profile with pin toggles, a way to
 * manage them and to the Chrome Web Store.
 */
export function ExtensionToolbar({
  guestId,
  partition,
  active,
  visible,
  onOpenExtensions,
  onOpenUrl,
}: {
  guestId: number | null;
  partition: string | undefined;
  /** This tab is the one in front: it shows install notices. */
  active: boolean;
  /** On screen; a hidden tab's toolbar does not follow its buttons. */
  visible: boolean;
  onOpenExtensions: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const actions = useExtensionActions(guestId, visible);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const pinned = actions.filter((action) => action.pinned);
  const [popup, setPopup] = useState<ExtensionPopupTarget | null>(null);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const nextOpenId = useRef(0);
  // Pressing an open popup's own button moves focus out of the popup,
  // which closes it before the click lands; the click then only finishes
  // the toggle instead of opening it again.
  const pressedOpen = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const puzzleRef = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [installed, setInstalled] = useState<ExtensionInstalled | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const anchorFor = useCallback(
    (extensionId: string) =>
      (
        buttons.current.get(extensionId) ?? puzzleRef.current
      )?.getBoundingClientRect() ??
      new DOMRect(window.innerWidth - 16, 40, 0, 0),
    [],
  );

  const run = useCallback(
    async (action: ExtensionActionState) => {
      setMenuOpen(false);
      // One popup at a time: its own button closes it, another's replaces it.
      const pressed = pressedOpen.current;
      pressedOpen.current = null;
      const open = popup?.extensionId ?? pressed;
      if (popup) setPopup(null);
      if (open === action.extensionId) return;
      const result = await desktopApi
        .extensionsActionClick({ id: action.extensionId, guestId })
        .catch(() => null);
      if (result?.popupUrl)
        setPopup({
          openId: ++nextOpenId.current,
          extensionId: action.extensionId,
          name: action.name,
          url: result.popupUrl,
          anchor: anchorFor(action.extensionId),
        });
    },
    [guestId, popup, anchorFor],
  );

  // `action.openPopup()` and an extension's keyboard shortcut.
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenExtensionPopupDetail>).detail;
      if (detail.guestId !== guestId || guestId === null) return;
      setMenuOpen(false);
      setPopup({
        openId: ++nextOpenId.current,
        extensionId: detail.extensionId,
        name:
          actionsRef.current.find(
            (action) => action.extensionId === detail.extensionId,
          )?.name ?? "Extension",
        url: detail.url,
        anchor: anchorFor(detail.extensionId),
      });
    };
    window.addEventListener(OPEN_EXTENSION_POPUP_EVENT, open);
    return () => window.removeEventListener(OPEN_EXTENSION_POPUP_EVENT, open);
  }, [guestId, anchorFor]);

  // A press or Escape in a page closes the popup (main/extensions/host.ts),
  // even one still loading.
  useEffect(
    () =>
      desktopApi.onExtensionsClosePopups(() => {
        pressedOpen.current = null;
        setPopup(null);
      }),
    [],
  );

  useEffect(
    () =>
      desktopApi.onExtensionInstalled((notice) => {
        if (activeRef.current) setInstalled(notice);
      }),
    [],
  );

  const menu = (action: ExtensionActionState) =>
    void desktopApi.extensionsActionMenu({ id: action.extensionId, guestId });

  // As many pinned buttons as fit beside an address field of a usable
  // width; the rest stay in the puzzle menu, as in Chrome.
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY);
  const pinnedCount = pinned.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the group mounts or empties as the pins change, and is measured again
  useLayoutEffect(() => {
    const group = pinnedRef.current;
    const address = group?.parentElement?.querySelector<HTMLElement>(
      "[data-address-field]",
    );
    if (!group || !address || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const room = address.offsetWidth + group.offsetWidth - MIN_ADDRESS_WIDTH;
      setFit(Math.max(0, Math.floor((room + PIN_GAP) / PIN_STEP)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(address);
    return () => observer.disconnect();
  }, [pinnedCount]);
  const shownPins = pinned.slice(0, fit);

  if (actions.length === 0) return null;
  return (
    <>
      <div
        ref={pinnedRef}
        data-testid="extension-pins"
        className="flex shrink-0 items-center gap-1 empty:hidden"
      >
        {shownPins.map((action) => (
          <ShortcutHint key={action.extensionId} label={action.title}>
            <button
              type="button"
              ref={(node) => {
                if (node) buttons.current.set(action.extensionId, node);
                else buttons.current.delete(action.extensionId);
              }}
              onPointerDown={(event) => {
                pressedOpen.current =
                  event.button === 0 &&
                  popupRef.current?.extensionId === action.extensionId
                    ? action.extensionId
                    : null;
              }}
              onClick={() => void run(action)}
              onContextMenu={(event) => {
                event.preventDefault();
                menu(action);
              }}
              aria-label={action.title}
              aria-pressed={popup?.extensionId === action.extensionId}
              data-testid="extension-action"
              data-extension-id={action.extensionId}
              className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay ${
                popup?.extensionId === action.extensionId ? "bg-bg-overlay" : ""
              } ${action.enabled ? "" : "opacity-45"}`}
            >
              <ExtensionIcon action={action} />
            </button>
          </ShortcutHint>
        ))}
      </div>
      <ShortcutHint label="Extensions">
        <button
          ref={puzzleRef}
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Extensions"
          aria-expanded={menuOpen}
          data-testid="extensions-button"
          className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg ${
            menuOpen ? "bg-bg-overlay text-fg" : ""
          }`}
        >
          <Puzzle className="size-3.5" />
        </button>
      </ShortcutHint>
      <ExtensionsMenu
        open={menuOpen}
        anchorRef={puzzleRef}
        actions={actions}
        onClose={() => setMenuOpen(false)}
        onRun={(action) => void run(action)}
        onMenu={menu}
        onManage={() => {
          setMenuOpen(false);
          onOpenExtensions();
        }}
        onStore={() => {
          setMenuOpen(false);
          onOpenUrl(CHROME_WEB_STORE_URL);
        }}
      />
      <ExtensionPopup
        target={popup}
        partition={partition}
        tabGuestId={guestId}
        onClose={() => setPopup(null)}
      />
      <InstalledNotice
        notice={installed}
        anchorRef={puzzleRef}
        onDone={() => setInstalled(null)}
      />
    </>
  );
}

function ExtensionsMenu({
  open,
  anchorRef,
  actions,
  onClose,
  onRun,
  onMenu,
  onManage,
  onStore,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  actions: ExtensionActionState[];
  onClose: () => void;
  onRun: (action: ExtensionActionState) => void;
  onMenu: (action: ExtensionActionState) => void;
  onManage: () => void;
  onStore: () => void;
}) {
  const theme = useTheme();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = useAnchoredPlace(anchorRef, open, 300);
  useEffect(() => {
    if (!open) return;
    // Portaled to the end of the page: keys reach its items only once
    // focus moves in, as the profile menu does.
    const frame = requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>("button")?.focus(),
    );
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      )
        return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchorRef, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Extensions"
      inert={!open ? true : undefined}
      data-testid="extensions-menu"
      data-theme={theme?.appearance}
      style={{ ...themeStyle(theme), ...place }}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) setMounted(false);
      }}
      className={`fixed z-[90] origin-top-right rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl ${
        open ? "animate-pop-in" : "pointer-events-none animate-pop-out"
      }`}
    >
      <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-fg-muted">
        Extensions
      </p>
      <ul className="max-h-[min(420px,60vh)] overflow-y-auto">
        {actions.map((action) => (
          <li
            key={action.extensionId}
            className="group flex items-center gap-1 rounded-md hover:bg-bg-raised"
          >
            <button
              type="button"
              onClick={() => onRun(action)}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(action);
              }}
              data-testid="extensions-menu-item"
              data-extension-id={action.extensionId}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg"
            >
              <ExtensionIcon action={{ ...action, badgeText: "" }} />
              <span className="truncate">{action.name}</span>
            </button>
            <ShortcutHint
              label={action.pinned ? "Unpin from toolbar" : "Pin to toolbar"}
            >
              <button
                type="button"
                onClick={() =>
                  void desktopApi.extensionsSetPinned({
                    id: action.extensionId,
                    pinned: !action.pinned,
                  })
                }
                aria-label={
                  action.pinned ? `Unpin ${action.name}` : `Pin ${action.name}`
                }
                aria-pressed={action.pinned}
                data-testid="extensions-menu-pin"
                className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay ${
                  action.pinned ? "text-accent" : "text-fg-faint hover:text-fg"
                }`}
              >
                <Pin
                  className={`size-3.5 ${action.pinned ? "fill-current" : ""}`}
                />
              </button>
            </ShortcutHint>
            <ShortcutHint label="More">
              <button
                type="button"
                onClick={() => onMenu(action)}
                aria-label={`More for ${action.name}`}
                className="mr-0.5 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </ShortcutHint>
          </li>
        ))}
      </ul>
      <div className="mt-1 border-t border-border pt-1">
        <button
          type="button"
          onClick={onManage}
          className="flex w-full cursor-pointer items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-bg-raised"
        >
          Manage extensions
        </button>
        <button
          type="button"
          onClick={onStore}
          className="flex w-full cursor-pointer items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-bg-raised"
        >
          Chrome Web Store
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** After an install: where the new extension lives, and a way to pin it. */
function InstalledNotice({
  notice,
  anchorRef,
  onDone,
}: {
  notice: ExtensionInstalled | null;
  anchorRef: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  const theme = useTheme();
  const [shown, setShown] = useState(notice);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (notice) setShown(notice);
  }, [notice]);
  const open = notice !== null;
  const place = useAnchoredPlace(anchorRef, open, 300);
  // Its clock runs from when it appears, however often the page re-renders.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!open || held) return;
    const timer = window.setTimeout(
      () => onDoneRef.current(),
      INSTALLED_LINGER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [open, held]);
  if (!shown) return null;
  return createPortal(
    <div
      role="status"
      data-testid="extension-installed"
      data-theme={theme?.appearance}
      style={{ ...themeStyle(theme), ...place }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) setShown(null);
      }}
      className={`fixed z-[90] origin-top-right rounded-lg border border-border bg-bg-overlay p-4 shadow-2xl ${
        open ? "animate-pop-in" : "pointer-events-none animate-pop-out"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-bg-inset">
          {shown.iconUrl ? (
            <img src={shown.iconUrl} alt="" className="size-5 object-contain" />
          ) : (
            <Puzzle className="size-4 text-fg-muted" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-fg">
            {shown.name} was added
          </p>
          <p className="mt-0.5 text-xs leading-5 text-fg-muted">
            {shown.hasAction
              ? "Find it in the extensions menu. Pin it to keep its button in the toolbar."
              : "It works on the pages it was made for."}
          </p>
        </div>
        <ShortcutHint label="Dismiss">
          <button
            type="button"
            onClick={onDone}
            aria-label="Dismiss"
            className="-mr-1.5 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
        </ShortcutHint>
      </div>
      {shown.hasAction && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="button-primary button-sm"
            data-testid="extension-installed-pin"
            onClick={() => {
              void desktopApi.extensionsSetPinned({
                id: shown.extensionId,
                pinned: true,
              });
              onDone();
            }}
          >
            Pin to toolbar
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
