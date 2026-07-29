import { LayoutGrid, Workflow as WorkflowIcon, X } from "lucide-react";

export type WorkspaceTab =
  | { kind: "workflow"; name: string; label?: string }
  | { kind: "app"; name: string; label?: string };

export const tabKey = (tab: WorkspaceTab) => `${tab.kind}:${tab.name}`;

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
    <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border px-3">
      {tabs.map((tab) => {
        const key = tabKey(tab);
        const active = key === activeKey;
        return (
          <div
            key={key}
            className={`group -mb-px flex h-8 shrink-0 items-center rounded-t-lg border px-1 text-[12px] transition-colors duration-150 ${
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
              {tab.kind === "workflow" ? (
                <WorkflowIcon className="size-3.5 shrink-0" />
              ) : (
                <LayoutGrid className="size-3.5 shrink-0" />
              )}
              <span className="max-w-40 truncate">{tab.label ?? tab.name}</span>
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
