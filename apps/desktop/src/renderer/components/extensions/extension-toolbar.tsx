import { MoreHorizontal, Pin, Puzzle, X } from "lucide-react";
import {
  type CSSProperties,
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
  anchor: HTMLElement | null,
  open: boolean,
  width: number,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ left: -10_000, top: 0 });
  useLayoutEffect(() => {
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
  }, [anchor, open, width]);
  return style;
}

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
  const pinned = actions.filter((action) => action.pinned);
  const [popup, setPopup] = useState<ExtensionPopupTarget | null>(null);
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
      const open = popup?.extensionId;
      if (open) setPopup(null);
      if (open === action.extensionId) return;
      const result = await desktopApi
        .extensionsActionClick({ id: action.extensionId, guestId })
        .catch(() => null);
      if (result?.popupUrl)
        setPopup({
          extensionId: action.extensionId,
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
        extensionId: detail.extensionId,
        url: detail.url,
        anchor: anchorFor(detail.extensionId),
      });
    };
    window.addEventListener(OPEN_EXTENSION_POPUP_EVENT, open);
    return () => window.removeEventListener(OPEN_EXTENSION_POPUP_EVENT, open);
  }, [guestId, anchorFor]);

  useEffect(
    () =>
      desktopApi.onExtensionInstalled((notice) => {
        if (activeRef.current) setInstalled(notice);
      }),
    [],
  );

  const menu = (action: ExtensionActionState) =>
    void desktopApi.extensionsActionMenu({ id: action.extensionId, guestId });

  if (actions.length === 0) return null;
  return (
    <>
      {pinned.map((action) => (
        <ShortcutHint key={action.extensionId} label={action.title}>
          <button
            type="button"
            ref={(node) => {
              if (node) buttons.current.set(action.extensionId, node);
              else buttons.current.delete(action.extensionId);
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
        anchor={puzzleRef.current}
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
        anchor={puzzleRef.current}
        onDone={() => setInstalled(null)}
      />
    </>
  );
}

function ExtensionsMenu({
  open,
  anchor,
  actions,
  onClose,
  onRun,
  onMenu,
  onManage,
  onStore,
}: {
  open: boolean;
  anchor: HTMLElement | null;
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
  const place = useAnchoredPlace(anchor, open, 300);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (panelRef.current?.contains(target) || anchor?.contains(target))
        return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchor, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Extensions"
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
            <ShortcutHint label={action.pinned ? "Unpin" : "Pin to toolbar"}>
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
  anchor,
  onDone,
}: {
  notice: ExtensionInstalled | null;
  anchor: HTMLElement | null;
  onDone: () => void;
}) {
  const theme = useTheme();
  const [shown, setShown] = useState(notice);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (notice) setShown(notice);
  }, [notice]);
  const open = notice !== null;
  const place = useAnchoredPlace(anchor, open, 300);
  useEffect(() => {
    if (!open || held) return;
    const timer = window.setTimeout(onDone, INSTALLED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [open, held, onDone]);
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
