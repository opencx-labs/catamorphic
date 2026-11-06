import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useRef,
  useState,
} from "react";
import { menuGroups } from "../../shared/menu.js";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeForAction,
  openModeFromEvent,
} from "../../shared/open-mode.js";
import { parseSurfaceLink } from "../../shared/surface-link.js";
import {
  actOnFile,
  type FileTarget,
  fileMenuFor,
  sayWhyFileActionFailed,
} from "./file-menu.js";
import {
  type ContextMenuEntry,
  type MenuAt,
  MenuPortal,
  menuAtPointer,
} from "./menu.js";

/** A resource's own verbs, after the ways to open it (a chat's Rename…). */
export interface ResourceActions {
  entries: readonly ContextMenuEntry[];
  onAction: (action: string) => void;
}

/**
 * A resource's right-click menu: the ways to open it, then, for a file,
 * what can be done with the file itself (`fileMenuFor`), then the
 * resource's own verbs.
 */
function useResourceMenu() {
  const [menu, setMenu] = useState<{
    at: MenuAt;
    opens: boolean;
    url: string | undefined;
    file: FileTarget | undefined;
    actions: ResourceActions | undefined;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined);
  // Stable: the menu leaves 180 ms after it closes, a wait that starts
  // again whenever this changes, and its owner may re-render sooner.
  const exited = useCallback(() => {
    setMenu(null);
    const chosen = pending.current;
    pending.current = undefined;
    chosen?.();
  }, []);
  const choose = useRef<((mode: OpenMode) => void) | undefined>(undefined);
  return {
    show({
      position,
      onOpen,
      file,
      actions,
      url,
    }: {
      position: { x: number; y: number };
      onOpen?: (mode: OpenMode) => void;
      file?: FileTarget;
      actions?: ResourceActions;
      url?: string;
    }) {
      pending.current = undefined;
      choose.current = onOpen;
      setMenu({
        at: menuAtPointer({ clientX: position.x, clientY: position.y }),
        opens: Boolean(onOpen),
        url,
        file,
        actions,
      });
      setOpen(true);
    },
    portal: menu && (
      <MenuPortal<ContextMenuEntry>
        open={open}
        at={menu.at}
        label={menu.opens ? "Open" : "Link"}
        entries={menuGroups<ContextMenuEntry>(
          menu.opens ? OPEN_ACTIONS : [],
          menu.file ? fileMenuFor(menu.file) : [],
          menu.url ? [{ label: "Copy link", action: "copy-link" }] : [],
          menu.actions?.entries ?? [],
        )}
        onPick={(entry) => {
          const mode = openModeForAction(entry.action);
          const own = menu.actions;
          // Opening and the resource's verbs run once the menu has left,
          // so what they open takes focus from nothing in the way.
          if (mode) pending.current = () => choose.current?.(mode);
          else if (entry.action === "copy-link" && menu.url)
            void navigator.clipboard.writeText(menu.url);
          else if (own?.entries.some((item) => item.action === entry.action))
            pending.current = () => own.onAction(entry.action);
          else if (menu.file) {
            const file = menu.file;
            void actOnFile(entry.action, file).catch((cause: unknown) =>
              sayWhyFileActionFailed(entry.action, file, cause),
            );
          }
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
        onExited={exited}
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
  file,
  actions,
  url,
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
  /** The resource is this file: its menu adds what can be done with it. */
  file?: FileTarget;
  /** The resource's own verbs, after the ways to open it. */
  actions?: ResourceActions;
  /** A web address this resource opens, copied as the address rather than its label. */
  url?: string;
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
          menu.show({
            position: {
              x: event.clientX || rect.left,
              y: event.clientY || rect.bottom,
            },
            onOpen,
            file,
            actions,
            url,
          });
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
  projectId,
}: {
  children: ReactNode;
  /** Omitted at the window boundary, where ordinary web links only need Copy link. */
  onOpen?: (url: string, mode: OpenMode) => void;
  /** Where a file link's path is from: its menu then acts on the file too. */
  projectId?: string;
}) {
  const menu = useResourceMenu();
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates the context menu of keyboard-accessible descendant links */}
      <div
        className="contents"
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          const target =
            event.target instanceof Element
              ? event.target.closest(
                  "a[href], [data-link-url], [data-file-path]",
                )
              : null;
          const url =
            target?.getAttribute("href") ??
            target?.getAttribute("data-link-url") ??
            (target?.getAttribute("data-file-path")
              ? `file:${target.getAttribute("data-file-path")}`
              : null);
          const link = url ? parseSurfaceLink(url) : null;
          if (!url || !link || (!onOpen && link.kind !== "browser")) return;
          event.preventDefault();
          event.stopPropagation();
          menu.show({
            position: { x: event.clientX, y: event.clientY },
            onOpen: onOpen ? (mode) => onOpen(url, mode) : undefined,
            file:
              link.kind === "file" && projectId
                ? { projectId, filePath: link.path }
                : undefined,
            url: link.kind === "browser" ? url : undefined,
          });
        }}
      >
        {children}
      </div>
      {menu.portal}
    </>
  );
}
