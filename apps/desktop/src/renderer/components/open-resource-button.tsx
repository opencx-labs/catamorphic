import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeFromEvent,
} from "../../shared/open-mode.js";
import { parseSurfaceLink } from "../../shared/surface-link.js";
import { MenuPortal } from "./sidebar-item-row.js";

function useResourceMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<OpenMode | undefined>(undefined);
  const choose = useRef<(mode: OpenMode) => void>(() => {});
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      )
        return;
      setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return {
    show(position: { x: number; y: number }, onOpen: (mode: OpenMode) => void) {
      pending.current = undefined;
      choose.current = onOpen;
      setMenu(position);
      setOpen(true);
    },
    portal: menu && (
      <MenuPortal
        open={open}
        position={menu}
        entries={OPEN_ACTIONS}
        onPick={(entry) => {
          pending.current = entry.mode;
          setOpen(false);
        }}
        onExited={() => {
          setMenu(null);
          const mode = pending.current;
          pending.current = undefined;
          if (mode) choose.current(mode);
        }}
      />
    ),
  };
}

/** Resource navigation only: folders and commands keep ordinary buttons. */
export function OpenResourceButton({
  onOpen,
  ref,
  defaultOpenMode = "replace",
  isResource = true,
  onKeyDown,
  onMouseDown,
  openOnMouseDown = false,
  ...props
}: Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "onContextMenu"
> & {
  onOpen: (mode: OpenMode) => void;
  ref?: Ref<HTMLButtonElement>;
  defaultOpenMode?: OpenMode;
  isResource?: boolean;
  openOnMouseDown?: boolean;
}) {
  const menu = useResourceMenu();
  return (
    <>
      <button
        {...props}
        ref={ref}
        type={props.type ?? "button"}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && event.key === "Enter") {
            event.preventDefault();
            onOpen(openModeFromEvent(event, defaultOpenMode));
          }
        }}
        onMouseDown={(event) => {
          onMouseDown?.(event);
          if (openOnMouseDown && event.button === 0) {
            event.preventDefault();
            onOpen(openModeFromEvent(event, defaultOpenMode));
          }
        }}
        onClick={(event) => {
          if (!openOnMouseDown)
            onOpen(openModeFromEvent(event, defaultOpenMode));
        }}
        onContextMenu={(event) => {
          if (!isResource) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          menu.show(
            { x: event.clientX || rect.left, y: event.clientY || rect.bottom },
            onOpen,
          );
        }}
      />
      {menu.portal}
    </>
  );
}

/** Delegates resource menus from Markdown anchors and edited-file rows. */
export function ResourceLinkBoundary({
  children,
  onOpen,
}: {
  children: ReactNode;
  onOpen: (url: string, mode: OpenMode) => void;
}) {
  const menu = useResourceMenu();
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates the context menu of keyboard-accessible descendant links */}
      <div
        className="contents"
        onContextMenu={(event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest("a[href], [data-file-path]")
              : null;
          const url =
            target?.getAttribute("href") ??
            (target?.getAttribute("data-file-path")
              ? `file:${target.getAttribute("data-file-path")}`
              : null);
          if (!url || !parseSurfaceLink(url)) return;
          event.preventDefault();
          event.stopPropagation();
          menu.show({ x: event.clientX, y: event.clientY }, (mode) =>
            onOpen(url, mode),
          );
        }}
      >
        {children}
      </div>
      {menu.portal}
    </>
  );
}
