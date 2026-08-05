import {
  Bot,
  ChevronsLeft,
  ChevronsRight,
  FileCode,
  Globe,
  LayoutGrid,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import { AnimatedTitle } from "./animated-title";
import { ShortcutHint } from "./shortcut-hint";

/** Live activity signals mirrored onto a tab's icon (chat tabs today). */
interface TabIndicators {
  /** Agent working → the icon cross-fades to a spinner. */
  sending?: boolean;
  /** Response landed while the tab was hidden → dot on the icon. */
  unread?: boolean;
  /** Chat group this tab belongs to (parent chat or attached surface). */
  groupId?: string;
}

export type WorkspaceTab = (
  | { kind: "workflow"; name: string; label?: string }
  | { kind: "app"; name: string; label?: string }
  | { kind: "chat"; name: string; label?: string }
  | {
      kind: "browser";
      name: string;
      label?: string;
      faviconUrl?: string | null;
    }
  | { kind: "settings"; name: string; label?: string }
  | { kind: "palette"; name: string; label?: string }
  | { kind: "agent-setup"; name: string; label?: string }
  | { kind: "terminal"; name: string; label?: string }
  | { kind: "editor"; name: string; label?: string }
) &
  TabIndicators;

export const tabKey = (tab: WorkspaceTab) => `${tab.kind}:${tab.name}`;

const TAB_ICONS = {
  workflow: WorkflowIcon,
  app: LayoutGrid,
  chat: MessageSquare,
  browser: Globe,
  settings: SettingsIcon,
  palette: Search,
  "agent-setup": Bot,
  terminal: SquareTerminal,
  editor: FileCode,
} as const;

interface RenderedTab {
  tab: WorkspaceTab;
  exiting: boolean;
}

/**
 * Merge incoming tabs with the previous render list so removed tabs stay
 * mounted (near their old position) while their exit animation plays. The
 * width collapse of an exiting tab is what slides its neighbors over.
 * Surviving tabs follow the INCOMING order — drag-reordering must move
 * them, not freeze them at their first-render positions.
 */
function mergeRendered(
  previous: RenderedTab[],
  tabs: WorkspaceTab[],
): RenderedTab[] {
  const incoming = new Set(tabs.map((tab) => tabKey(tab)));
  const merged: RenderedTab[] = tabs.map((tab) => ({ tab, exiting: false }));
  previous.forEach((entry, index) => {
    if (incoming.has(tabKey(entry.tab))) return;
    merged.splice(Math.min(index, merged.length), 0, {
      tab: entry.tab,
      exiting: true,
    });
  });
  return merged;
}

function CloseButton({
  hint,
  label,
  className,
  onClick,
}: {
  hint: boolean;
  label: string;
  className: string;
  onClick: () => void;
}) {
  const keybindings = useKeybindings();
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={`grid size-5 cursor-pointer place-items-center rounded text-fg-faint transition-opacity duration-150 hover:text-fg ${className}`}
      aria-label={label}
    >
      <X className="size-3" />
    </button>
  );
  return hint ? (
    <ShortcutHint
      label="Close tab"
      shortcut={formatBinding(keybindings["close-tab"])}
    >
      {button}
    </ShortcutHint>
  ) : (
    <ShortcutHint label={label}>{button}</ShortcutHint>
  );
}

/**
 * Tab strip only — the host owns the surrounding top bar (drag region,
 * sidebar toggle) so tabs and window chrome share one row.
 */
export interface TabGroup {
  /** The owning chat's tab key. */
  parentKey: string;
  /** Attached tab keys, in strip order (empty when collapsed hides them). */
  memberKeys: string[];
  collapsed: boolean;
}

export function WorkspaceTabBar({
  tabs,
  activeKey,
  secondaryKey,
  highlightKey,
  groups = [],
  onSelect,
  onClose,
  onNew,
  onToggleGroup,
  onReorder,
  onDragStateChange,
}: {
  tabs: WorkspaceTab[];
  activeKey?: string;
  /** The unfocused pane of a split view — styled active but muted. */
  secondaryKey?: string;
  /**
   * Tab a highlighted palette command would act on — rendered with an
   * accent border so "Close tab" (etc.) points at its target before Enter.
   */
  highlightKey?: string;
  /** Chat groups: parent chat tab + its attached surfaces. */
  groups?: TabGroup[];
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Chrome-style + after the last tab; always opens a new tab. */
  onNew?: () => void;
  /** Fold/unfold a group's members (by the owning chat's localId). */
  onToggleGroup?: (chatLocalId: string) => void;
  /** Drag-reorder: move `key` before `beforeKey` (null = to the end). */
  onReorder?: (key: string, beforeKey: string | null) => void;
  /** A tab drag started (key) or ended (null) — hosts show drop zones. */
  onDragStateChange?: (key: string | null) => void;
}) {
  const keybindings = useKeybindings();
  const [rendered, setRendered] = useState<RenderedTab[]>(() =>
    mergeRendered([], tabs),
  );
  const prevTabsRef = useRef(tabs);
  if (prevTabsRef.current !== tabs) {
    prevTabsRef.current = tabs;
    setRendered((previous) => mergeRendered(previous, tabs));
  }
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropBeforeKey, setDropBeforeKey] = useState<string | null>(null);
  const groupByParent = new Map(
    groups.map((group) => [group.parentKey, group]),
  );
  const lastMemberKeys = new Map(
    groups
      .filter((group) => !group.collapsed && group.memberKeys.length > 0)
      .map((group) => [group.memberKeys.at(-1) as string, group]),
  );

  const removeExited = (key: string) =>
    setRendered((previous) =>
      previous.filter((entry) => !(entry.exiting && tabKey(entry.tab) === key)),
    );

  if (rendered.length === 0 && !onNew) return null;
  return (
    // overflow-y-hidden: tabs hang 1px below the row (-mb-px overlaps the
    // border), and overflow-x-auto alone turns that spill into a phantom
    // vertical scrollbar in the corner.
    <div
      className="app-no-drag flex min-w-0 flex-1 items-end gap-1 self-stretch overflow-x-auto overflow-y-hidden"
      onDragOver={(event) => {
        if (dragKey) {
          event.preventDefault();
          setDropBeforeKey(null);
        }
      }}
      onDrop={(event) => {
        if (!dragKey) return;
        event.preventDefault();
        onReorder?.(dragKey, null);
        setDragKey(null);
        setDropBeforeKey(null);
        onDragStateChange?.(null);
      }}
    >
      {rendered.map(({ tab, exiting }, index) => {
        const key = tabKey(tab);
        const active = !exiting && key === activeKey;
        const secondary = !exiting && key === secondaryKey;
        const highlighted = !exiting && key === highlightKey;
        const Icon = TAB_ICONS[tab.kind];
        const parentGroup = groupByParent.get(key);
        const closesGroup = !exiting ? lastMemberKeys.get(key) : undefined;
        // The split pair merges into one bubble when adjacent: facing
        // corners square off, inner borders drop, and the gap closes.
        const inPair =
          !exiting &&
          Boolean(secondaryKey) &&
          (key === activeKey || key === secondaryKey);
        const neighborInPair = (neighbor?: RenderedTab) =>
          Boolean(
            neighbor &&
              !neighbor.exiting &&
              tabKey(neighbor.tab) !== key &&
              (tabKey(neighbor.tab) === activeKey ||
                tabKey(neighbor.tab) === secondaryKey),
          );
        const mergeRight = inPair && neighborInPair(rendered[index + 1]);
        const mergeLeft = inPair && neighborInPair(rendered[index - 1]);
        return (
          <Fragment key={key}>
            <div
              data-palette-target={highlighted || undefined}
              draggable={Boolean(onReorder) && !exiting}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", key);
                event.dataTransfer.effectAllowed = "move";
                setDragKey(key);
                onDragStateChange?.(key);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDropBeforeKey(null);
                onDragStateChange?.(null);
              }}
              onDragOver={(event) => {
                if (!dragKey || dragKey === key) return;
                event.preventDefault();
                event.stopPropagation();
                setDropBeforeKey(key);
              }}
              onDragLeave={() =>
                setDropBeforeKey((current) =>
                  current === key ? null : current,
                )
              }
              onDrop={(event) => {
                if (!dragKey || dragKey === key) return;
                event.preventDefault();
                event.stopPropagation();
                onReorder?.(dragKey, key);
                setDragKey(null);
                setDropBeforeKey(null);
                onDragStateChange?.(null);
              }}
              onAnimationEnd={(event) => {
                if (event.animationName === "tab-out") removeExited(key);
              }}
              className={`group -mb-px flex h-8 shrink-0 items-center rounded-t-lg border px-1 text-[12px] transition-[margin,border-radius,color,background-color,border-color] duration-150 ${
                mergeRight ? "rounded-tr-none border-r-0 " : ""
              }${mergeLeft ? "-ml-1 rounded-tl-none border-l-0 " : ""}${
                tab.groupId ? "border-t-2 border-t-accent/40 " : ""
              }${dragKey === key ? "opacity-50 " : ""}${
                dropBeforeKey === key ? "border-l-2 border-l-accent " : ""
              }${
                exiting
                  ? "animate-tab-out pointer-events-none"
                  : "animate-tab-in"
              } ${
                highlighted
                  ? active
                    ? "border-accent border-b-bg bg-bg text-fg"
                    : "border-accent text-fg"
                  : active
                    ? "border-border border-b-bg bg-bg text-fg"
                    : secondary
                      ? "border-border border-b-bg bg-bg text-fg-muted"
                      : "border-transparent text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
              }`}
              aria-hidden={exiting || undefined}
            >
              <button
                type="button"
                onClick={() => onSelect(key)}
                className="flex cursor-pointer items-center gap-1.5 px-1.5"
              >
                {/* Stacked like the chat bubbles: icon cross-fades to a
                  spinner while the agent works; unread lands as a dot. */}
                <span className="relative grid size-3.5 shrink-0 place-items-center">
                  {tab.kind === "browser" && tab.faviconUrl ? (
                    <img
                      src={tab.faviconUrl}
                      alt=""
                      className={`col-start-1 row-start-1 size-3.5 rounded-[3px] transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                        tab.sending
                          ? "scale-50 opacity-0"
                          : "scale-100 opacity-100"
                      }`}
                    />
                  ) : (
                    <Icon
                      className={`col-start-1 row-start-1 size-3.5 transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                        tab.sending
                          ? "scale-50 opacity-0"
                          : "scale-100 opacity-100"
                      }`}
                    />
                  )}
                  <LoaderCircle
                    className={`col-start-1 row-start-1 size-3.5 animate-spin text-accent transition-[opacity] duration-200 ${
                      tab.sending ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <span
                    className={`absolute -right-1 -top-1 size-1.5 rounded-full bg-accent transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                      tab.unread && !tab.sending
                        ? "scale-100 opacity-100"
                        : "scale-0 opacity-0"
                    }`}
                  />
                </span>
                <AnimatedTitle
                  text={tab.label ?? tab.name}
                  className="max-w-40"
                />
              </button>
              {/* Collapsed group parent: expand its folded surfaces. */}
              {parentGroup?.collapsed && onToggleGroup && (
                <button
                  type="button"
                  onClick={() =>
                    onToggleGroup(parentGroup.parentKey.slice("chat:".length))
                  }
                  className="flex h-5 cursor-pointer items-center gap-0.5 rounded px-1 text-[10px] text-accent/80 transition-colors duration-150 hover:bg-bg-overlay hover:text-accent"
                  aria-label={`Expand ${parentGroup.memberKeys.length} grouped tabs`}
                  title="Expand grouped tabs"
                >
                  <ChevronsRight className="size-3" />
                  {parentGroup.memberKeys.length}
                </button>
              )}
              {/* ⌘W closes the ACTIVE tab, so only its X advertises it. */}
              <CloseButton
                hint={active}
                label={`Close ${tab.label ?? tab.name}`}
                className={active ? "" : "opacity-0 group-hover:opacity-100"}
                onClick={() => onClose(key)}
              />
            </div>
            {/* Last member of an expanded group: fold the group away. */}
            {closesGroup && onToggleGroup && (
              <button
                type="button"
                onClick={() =>
                  onToggleGroup(closesGroup.parentKey.slice("chat:".length))
                }
                className="grid size-6 shrink-0 cursor-pointer place-items-center self-center rounded text-accent/70 transition-colors duration-150 hover:bg-bg-overlay hover:text-accent"
                aria-label="Collapse grouped tabs"
                title="Collapse grouped tabs"
              >
                <ChevronsLeft className="size-3.5" />
              </button>
            )}
          </Fragment>
        );
      })}
      {onNew && (
        // self-stretch + items-center: the + rides mid-row like the
        // sidebar toggle, not glued to the tabs' hanging baseline. The
        // ShortcutHint wrapper is the flex item, so centering lives on
        // this container, not the button.
        <div className="flex shrink-0 items-center self-stretch">
          <ShortcutHint
            label="New tab"
            shortcut={formatBinding(keybindings["new-tab"])}
          >
            <button
              type="button"
              onClick={onNew}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              aria-label="New tab"
            >
              <Plus className="size-4" />
            </button>
          </ShortcutHint>
        </div>
      )}
    </div>
  );
}
