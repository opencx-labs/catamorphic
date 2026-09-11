import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ItemAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabledReason?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

/** The same action definition can be placed inline, in overflow or on right click. */
export function useItemActions() {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const run = async (action: ItemAction) => {
    if (busy.current || action.disabledReason) return;
    busy.current = true;
    setPending(action.id);
    setError(undefined);
    try {
      await action.run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  };
  return { run, pending, error };
}

/** Portable item chrome. Hosts can replace each visual slot or the entire row. */
export function CollectionItemView({
  id,
  label,
  description,
  icon,
  badges,
  progress,
  active,
  expanded,
  onToggle,
  onOpen,
  actions = [],
  menu = [],
  contextMenu = menu,
  preview,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  badges?: readonly ReactNode[];
  progress?: number;
  active?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
  actions?: readonly ItemAction[];
  menu?: readonly ItemAction[];
  contextMenu?: readonly ItemAction[];
  preview?: ReactNode;
  children?: ReactNode;
}) {
  const actionState = useItemActions();
  const [overlay, setOverlay] = useState<{
    x: number;
    y: number;
    actions: readonly ItemAction[];
  }>();
  const [inspecting, setInspecting] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const portal = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const restoreFocus = () =>
    anchor.current
      ?.querySelector<HTMLElement>(".cat-collection-label")
      ?.focus();
  useEffect(() => {
    if (!inspecting) return;
    inspector.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !inspector.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        setInspecting(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [inspecting]);
  useEffect(() => {
    if (!overlay) return;
    portal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => {
      if (
        event.target instanceof Node &&
        portal.current?.contains(event.target)
      )
        return;
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      setOverlay(undefined);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [overlay]);
  const actionButton = (action: ItemAction, inMenu = false) => (
    <button
      key={action.id}
      type="button"
      role={inMenu ? "menuitem" : undefined}
      className="cat-btn cat-btn-ghost"
      data-danger={action.danger || undefined}
      aria-label={action.label}
      aria-disabled={
        Boolean(action.disabledReason) || Boolean(actionState.pending)
      }
      data-disabled-reason={action.disabledReason}
      aria-busy={actionState.pending === action.id}
      onClick={() => {
        if (actionState.pending || action.disabledReason) return;
        setOverlay(undefined);
        restoreFocus();
        void actionState.run(action);
      }}
    >
      {action.icon}
      {inMenu || !action.icon ? action.label : null}
      {inMenu && action.disabledReason ? (
        <small>{action.disabledReason}</small>
      ) : null}
    </button>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: context menu has equivalent keyboard access on the item controls.
    <div
      ref={anchor}
      data-collection-item={id}
      data-interacting={overlay || inspecting ? "true" : undefined}
      className="cat-collection-item"
      data-active={active || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        if (contextMenu.length)
          setOverlay({
            x: event.clientX,
            y: event.clientY,
            actions: contextMenu,
          });
      }}
      onKeyDown={(event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          const rect = anchor.current?.getBoundingClientRect();
          if (rect && contextMenu.length)
            setOverlay({ x: rect.left, y: rect.bottom, actions: contextMenu });
        }
      }}
    >
      {onToggle && (
        <button
          type="button"
          className="cat-btn cat-btn-ghost"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "▾" : "▸"}
        </button>
      )}
      <button
        type="button"
        className="cat-collection-label"
        onClick={onOpen ?? onToggle}
        aria-current={active || undefined}
      >
        {icon}
        <span>
          {label}
          {description && <small>{description}</small>}
        </span>
      </button>
      {badges?.map((badge, index) => (
        <span
          key={typeof badge === "string" ? badge : index}
          className="cat-badge"
        >
          {badge}
        </span>
      ))}
      {progress !== undefined && (
        <progress aria-label={`${label} progress`} max={1} value={progress} />
      )}
      {children}
      {actions.map((action) => actionButton(action))}
      {preview && (
        <button
          type="button"
          className="cat-btn cat-btn-ghost"
          aria-label={`Inspect ${label}`}
          aria-expanded={inspecting}
          onClick={() => {
            setOverlay(undefined);
            setInspecting((value) => !value);
          }}
        >
          ⓘ
        </button>
      )}
      {menu.length > 0 && (
        <button
          type="button"
          className="cat-btn cat-btn-ghost"
          aria-label={`More actions for ${label}`}
          aria-haspopup="menu"
          onClick={() => {
            setInspecting(false);
            const rect = anchor.current?.getBoundingClientRect();
            if (rect)
              setOverlay({
                x: rect.right - 180,
                y: rect.bottom,
                actions: menu,
              });
          }}
        >
          ⋯
        </button>
      )}
      {actionState.error && <span role="alert">{actionState.error}</span>}
      {inspecting &&
        createPortal(
          <div
            ref={inspector}
            role="dialog"
            tabIndex={-1}
            aria-label={`${label} details`}
            className="cat-collection-inspector"
            style={{
              left: Math.max(
                8,
                Math.min(
                  anchor.current?.getBoundingClientRect().left ?? 8,
                  window.innerWidth - 328,
                ),
              ),
              top: Math.max(
                8,
                Math.min(
                  anchor.current?.getBoundingClientRect().bottom ?? 8,
                  window.innerHeight - 328,
                ),
              ),
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setInspecting(false);
                restoreFocus();
              }
            }}
          >
            <button
              type="button"
              className="cat-btn cat-btn-ghost"
              aria-label={`Close ${label} details`}
              onClick={() => {
                setInspecting(false);
                restoreFocus();
              }}
            >
              Close
            </button>
            {preview}
          </div>,
          document.body,
        )}
      {overlay &&
        createPortal(
          <div
            ref={portal}
            role="menu"
            className="cat-collection-menu"
            style={{
              left: Math.max(8, Math.min(overlay.x, window.innerWidth - 200)),
              top: Math.max(
                8,
                Math.min(
                  overlay.y,
                  window.innerHeight -
                    Math.min(320, overlay.actions.length * 36),
                ),
              ),
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOverlay(undefined);
                anchor.current
                  ?.querySelector<HTMLElement>(".cat-collection-label")
                  ?.focus();
                return;
              }
              const buttons = [
                ...(portal.current?.querySelectorAll<HTMLButtonElement>(
                  "button",
                ) ?? []),
              ];
              const index =
                document.activeElement instanceof HTMLButtonElement
                  ? buttons.indexOf(document.activeElement)
                  : -1;
              const target =
                event.key === "ArrowDown"
                  ? (index + 1) % buttons.length
                  : event.key === "ArrowUp"
                    ? (index + buttons.length - 1) % buttons.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : undefined;
              if (target !== undefined) {
                event.preventDefault();
                buttons[target]?.focus();
              }
            }}
          >
            {overlay.actions.map((action) => actionButton(action, true))}
          </div>,
          document.body,
        )}
    </div>
  );
}
