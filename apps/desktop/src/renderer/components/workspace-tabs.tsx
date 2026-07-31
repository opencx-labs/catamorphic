import {
  LayoutGrid,
  MessageSquare,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { AnimatedTitle } from "./animated-title";

export type WorkspaceTab =
  | { kind: "workflow"; name: string; label?: string }
  | { kind: "app"; name: string; label?: string }
  | { kind: "chat"; name: string; label?: string };

export const tabKey = (tab: WorkspaceTab) => `${tab.kind}:${tab.name}`;

const TAB_ICONS = {
  workflow: WorkflowIcon,
  app: LayoutGrid,
  chat: MessageSquare,
} as const;

/**
 * Tab strip only — the host owns the surrounding top bar (drag region,
 * sidebar toggle) so tabs and window chrome share one row.
 */
export function WorkspaceTabBar({
  tabs,
  activeKey,
  onSelect,
  onClose,
}: {
  tabs: WorkspaceTab[];
  activeKey?: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="app-no-drag flex min-w-0 flex-1 items-end gap-1 self-stretch overflow-x-auto">
      {tabs.map((tab) => {
        const key = tabKey(tab);
        const active = key === activeKey;
        const Icon = TAB_ICONS[tab.kind];
        return (
          <div
            key={key}
            className={`group animate-tab-in -mb-px flex h-8 shrink-0 items-center rounded-t-lg border px-1 text-[12px] transition-colors duration-150 ${
              active
                ? "border-border border-b-bg bg-bg text-fg"
                : "border-transparent text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(key)}
              className="flex cursor-pointer items-center gap-1.5 px-1.5"
            >
              <Icon className="size-3.5 shrink-0" />
              <AnimatedTitle
                text={tab.label ?? tab.name}
                className="max-w-40"
              />
            </button>
            <button
              type="button"
              onClick={() => onClose(key)}
              className={`grid size-5 cursor-pointer place-items-center rounded text-fg-faint transition-opacity duration-150 hover:text-fg ${
                active ? "" : "opacity-0 group-hover:opacity-100"
              }`}
              aria-label={`Close ${tab.label ?? tab.name}`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
