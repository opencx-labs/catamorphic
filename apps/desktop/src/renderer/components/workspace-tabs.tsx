import {
  Globe,
  LayoutGrid,
  MessageSquare,
  Plus,
  Search,
  Settings as SettingsIcon,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import { AnimatedTitle } from "./animated-title";
import { ShortcutHint } from "./shortcut-hint";

export type WorkspaceTab =
  | { kind: "workflow"; name: string; label?: string }
  | { kind: "app"; name: string; label?: string }
  | { kind: "chat"; name: string; label?: string }
  | { kind: "browser"; name: string; label?: string; faviconUrl?: string | null }
  | { kind: "settings"; name: string; label?: string }
  | { kind: "palette"; name: string; label?: string };

export const tabKey = (tab: WorkspaceTab) => `${tab.kind}:${tab.name}`;

const TAB_ICONS = {
  workflow: WorkflowIcon,
  app: LayoutGrid,
  chat: MessageSquare,
  browser: Globe,
  settings: SettingsIcon,
  palette: Search,
} as const;

interface RenderedTab {
  tab: WorkspaceTab;
  exiting: boolean;
}

/**
 * Merge incoming tabs with the previous render list so removed tabs stay
 * mounted (at their old position) while their exit animation plays. The
 * width collapse of an exiting tab is what slides its neighbors over.
 */
function mergeRendered(
  previous: RenderedTab[],
  tabs: WorkspaceTab[],
): RenderedTab[] {
  const byKey = new Map(tabs.map((tab) => [tabKey(tab), tab]));
  const seen = new Set<string>();
  const merged: RenderedTab[] = [];
  for (const entry of previous) {
    const key = tabKey(entry.tab);
    const current = byKey.get(key);
    if (current) {
      seen.add(key);
      merged.push({ tab: current, exiting: false });
    } else {
      merged.push({ tab: entry.tab, exiting: true });
    }
  }
  for (const tab of tabs) {
    if (!seen.has(tabKey(tab))) merged.push({ tab, exiting: false });
  }
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
    button
  );
}

/**
 * Tab strip only — the host owns the surrounding top bar (drag region,
 * sidebar toggle) so tabs and window chrome share one row.
 */
export function WorkspaceTabBar({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: WorkspaceTab[];
  activeKey?: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Chrome-style + after the last tab; always opens a new tab. */
  onNew?: () => void;
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

  const removeExited = (key: string) =>
    setRendered((previous) =>
      previous.filter((entry) => !(entry.exiting && tabKey(entry.tab) === key)),
    );

  if (rendered.length === 0 && !onNew) return null;
  return (
    // overflow-y-hidden: tabs hang 1px below the row (-mb-px overlaps the
    // border), and overflow-x-auto alone turns that spill into a phantom
    // vertical scrollbar in the corner.
    <div className="app-no-drag flex min-w-0 flex-1 items-end gap-1 self-stretch overflow-x-auto overflow-y-hidden">
      {rendered.map(({ tab, exiting }) => {
        const key = tabKey(tab);
        const active = !exiting && key === activeKey;
        const Icon = TAB_ICONS[tab.kind];
        return (
          <div
            key={key}
            onAnimationEnd={(event) => {
              if (event.animationName === "tab-out") removeExited(key);
            }}
            className={`group -mb-px flex h-8 shrink-0 items-center rounded-t-lg border px-1 text-[12px] transition-colors duration-150 ${
              exiting ? "animate-tab-out pointer-events-none" : "animate-tab-in"
            } ${
              active
                ? "border-border border-b-bg bg-bg text-fg"
                : "border-transparent text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
            aria-hidden={exiting || undefined}
          >
            <button
              type="button"
              onClick={() => onSelect(key)}
              className="flex cursor-pointer items-center gap-1.5 px-1.5"
            >
              {tab.kind === "browser" && tab.faviconUrl ? (
                <img
                  src={tab.faviconUrl}
                  alt=""
                  className="size-3.5 shrink-0 rounded-[3px]"
                />
              ) : (
                <Icon className="size-3.5 shrink-0" />
              )}
              <AnimatedTitle
                text={tab.label ?? tab.name}
                className="max-w-40"
              />
            </button>
            {/* ⌘W closes the ACTIVE tab, so only its X advertises it. */}
            <CloseButton
              hint={active}
              label={`Close ${tab.label ?? tab.name}`}
              className={active ? "" : "opacity-0 group-hover:opacity-100"}
              onClick={() => onClose(key)}
            />
          </div>
        );
      })}
      {onNew && (
        <ShortcutHint
          label="New tab"
          shortcut={formatBinding(keybindings["new-tab"])}
        >
          <button
            type="button"
            onClick={onNew}
            // self-center: the + rides mid-row, not glued to the tab
            // baseline (matches Chrome).
            className="grid size-7 shrink-0 cursor-pointer place-items-center self-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
            aria-label="New tab"
          >
            <Plus className="size-4" />
          </button>
        </ShortcutHint>
      )}
    </div>
  );
}
