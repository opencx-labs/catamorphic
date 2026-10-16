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

/**
 * A resource's right-click menu: the ways to open it, then, for a file,
 * what can be done with the file itself (`fileMenuFor`).
 */
function useResourceMenu() {
  const [menu, setMenu] = useState<{
    at: MenuAt;
    file: FileTarget | undefined;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<OpenMode | undefined>(undefined);
  const choose = useRef<(mode: OpenMode) => void>(() => {});
  // Stable: the menu leaves 180 ms after it closes, a wait that starts
  // again whenever this changes, and its owner may re-render sooner.
  const exited = useCallback(() => {
    setMenu(null);
    const mode = pending.current;
    pending.current = undefined;
    if (mode) choose.current(mode);
  }, []);
  return {
    show(
      position: { x: number; y: number },
      onOpen: (mode: OpenMode) => void,
      file?: FileTarget,
    ) {
      pending.current = undefined;
      choose.current = onOpen;
      setMenu({
        at: menuAtPointer({ clientX: position.x, clientY: position.y }),
        file,
      });
      setOpen(true);
    },
    portal: menu && (
      <MenuPortal<ContextMenuEntry>
        open={open}
        at={menu.at}
        label="Open"
        entries={menuGroups<ContextMenuEntry>(
          OPEN_ACTIONS,
          menu.file ? fileMenuFor(menu.file) : [],
        )}
        onPick={(entry) => {
          const mode = openModeForAction(entry.action);
          if (mode) pending.current = mode;
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
            file,
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
  projectId,
}: {
  children: ReactNode;
  onOpen: (url: string, mode: OpenMode) => void;
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
          const target =
            event.target instanceof Element
              ? event.target.closest("a[href], [data-file-path]")
              : null;
          const url =
            target?.getAttribute("href") ??
            (target?.getAttribute("data-file-path")
              ? `file:${target.getAttribute("data-file-path")}`
              : null);
          const link = url ? parseSurfaceLink(url) : null;
          if (!url || !link) return;
          event.preventDefault();
          event.stopPropagation();
          menu.show(
            { x: event.clientX, y: event.clientY },
            (mode) => onOpen(url, mode),
            link.kind === "file" && projectId
              ? { projectId, filePath: link.path }
              : undefined,
          );
        }}
      >
        {children}
      </div>
      {menu.portal}
    </>
  );
}
