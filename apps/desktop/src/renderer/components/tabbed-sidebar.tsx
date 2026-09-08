import * as icons from "lucide-react";
import { Circle, Plus } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  SidebarSectionConfig,
  SidebarSide,
  SidebarTabConfig,
} from "../../shared/sidebar.js";
import { ShortcutHint } from "./shortcut-hint.js";

interface LayoutState {
  width: number;
  selected: string;
}
function readLayout(key: string, side: SidebarSide): LayoutState {
  const fallback = { width: side === "left" ? 260 : 320, selected: "" };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return {
      width:
        typeof value?.width === "number"
          ? Math.max(220, Math.min(520, value.width))
          : fallback.width,
      selected: typeof value?.selected === "string" ? value.selected : "",
    };
  } catch {
    return fallback;
  }
}

function TabIcon({ name }: { name?: string }) {
  const Icon =
    Object.entries(icons.icons).find(([key]) => key === name)?.[1] ?? Circle;
  return <Icon className="size-4" aria-hidden="true" />;
}

/** Both sides use the same chrome, keyboard model and persistent panel lifecycle. */
export function TabbedSidebar({
  side,
  sidebarRef,
  overlay = false,
  revealed = false,
  tabs,
  open,
  scope,
  header,
  footer,
  error,
  onCustomize,
  renderSection,
}: {
  side: SidebarSide;
  sidebarRef?: Ref<HTMLElement>;
  overlay?: boolean;
  revealed?: boolean;
  tabs: SidebarTabConfig[];
  open: boolean;
  scope: string;
  header?: ReactNode;
  footer?: ReactNode;
  error?: string;
  onCustomize: () => void;
  renderSection: (section: SidebarSectionConfig, visible: boolean) => ReactNode;
}) {
  const storageKey = `catamorphic:sidebar:${scope}:${side}`;
  const [layout, setLayout] = useState(() => readLayout(storageKey, side));
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [resizing, setResizing] = useState(false);
  const [tabMotion, setTabMotion] = useState(false);
  const root = useRef<HTMLElement>(null);
  const id = useId();
  const selected =
    tabs.find((tab) => tab.id === layout.selected)?.id ?? tabs[0]?.id;
  useEffect(() => {
    // Persist the initial tab before the first click. Keep an existing choice
    // while tabs are temporarily filtered during project/permission loading.
    if (selected && !layout.selected)
      setLayout((current) => ({ ...current, selected }));
  }, [selected, layout.selected]);
  useEffect(() => {
    if (open && selected)
      setVisited((current) =>
        current.has(selected) ? current : new Set([...current, selected]),
      );
  }, [open, selected]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(layout));
  }, [storageKey, layout]);
  const select = (tabId: string) => {
    setTabMotion(true);
    setLayout((current) => ({ ...current, selected: tabId }));
  };
  return (
    <aside
      ref={(element) => {
        root.current = element;
        if (typeof sidebarRef === "function") sidebarRef(element);
        else if (sidebarRef) sidebarRef.current = element;
      }}
      data-sidebar={side}
      data-tab-motion={tabMotion}
      data-resizing={resizing || undefined}
      data-sidebar-revealed={revealed}
      data-overlay={overlay || undefined}
      className={`tabbed-sidebar ${overlay ? "absolute inset-y-0 left-0 z-40 rounded-r-xl shadow-xl" : ""}`}
      aria-label={`${side === "left" ? "Left" : "Right"} sidebar`}
      aria-hidden={!open}
      inert={!open}
      style={{
        width: open ? layout.width : 0,
        viewTransitionName: open ? `sidebar-${side}` : "none",
      }}
    >
      <div className="sidebar-inner" style={{ width: layout.width }}>
        {header}
        {tabs.length > 1 && (
          <div className="flex h-10 shrink-0 items-center justify-center px-2">
            <div
              role="tablist"
              aria-label={`${side === "left" ? "Left" : "Right"} sidebar tabs`}
              className="flex min-w-0 max-w-full items-center justify-center gap-1 overflow-x-auto"
            >
              {tabs.map((tab, index) => (
                <ShortcutHint key={tab.id} label={tab.title}>
                  <button
                    type="button"
                    role="tab"
                    id={`${id}-tab-${tab.id}`}
                    aria-controls={`${id}-panel-${tab.id}`}
                    aria-label={tab.title}
                    aria-selected={selected === tab.id}
                    tabIndex={selected === tab.id ? 0 : -1}
                    className="sidebar-tab"
                    onClick={() => select(tab.id)}
                    onKeyDown={(event) => {
                      const next =
                        event.key === "ArrowRight"
                          ? (index + 1) % tabs.length
                          : event.key === "ArrowLeft"
                            ? (index + tabs.length - 1) % tabs.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? tabs.length - 1
                                : null;
                      if (next === null) return;
                      event.preventDefault();
                      const target = tabs[next];
                      if (target) {
                        select(target.id);
                        document
                          .getElementById(`${id}-tab-${target.id}`)
                          ?.focus();
                      }
                    }}
                  >
                    <TabIcon name={tab.icon} />
                  </button>
                </ShortcutHint>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="px-3 pb-2 text-xs text-warning">
            Sidebar could not reload. {error}
          </p>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tabpanel"
              id={`${id}-panel-${tab.id}`}
              aria-labelledby={
                tabs.length > 1 ? `${id}-tab-${tab.id}` : undefined
              }
              aria-label={tabs.length > 1 ? undefined : tab.title}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tab panels must be keyboard reachable when content has no focusable controls
              tabIndex={0}
              hidden={selected !== tab.id}
              inert={selected !== tab.id || !open}
              className="sidebar-tab-panel"
            >
              {(visited.has(tab.id) || (open && selected === tab.id)) &&
                tab.sections.map((section) => (
                  <div key={section.id} data-sidebar-widget={section.id}>
                    {renderSection(section, open && selected === tab.id)}
                  </div>
                ))}
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="grid h-full place-items-center p-4">
              <button
                type="button"
                onClick={onCustomize}
                className="mx-auto flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-4 text-[13px] text-fg-muted transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Plus className="size-4" />
                Add tab
              </button>
            </div>
          )}
        </div>
        {footer}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: interactive resize separator, not a thematic break */}
      <div
        role="separator"
        aria-label={`Resize ${side} sidebar`}
        aria-orientation="vertical"
        aria-valuemin={220}
        aria-valuemax={520}
        aria-valuenow={layout.width}
        tabIndex={open ? 0 : -1}
        className="sidebar-resizer"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta =
            (event.key === "ArrowRight" ? 20 : -20) *
            (side === "left" ? 1 : -1);
          setLayout((current) => ({
            ...current,
            width: Math.max(220, Math.min(520, current.width + delta)),
          }));
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const rect = root.current?.getBoundingClientRect();
          if (rect)
            setLayout((current) => ({
              ...current,
              width: Math.max(
                220,
                Math.min(
                  520,
                  side === "left"
                    ? event.clientX - rect.left
                    : rect.right - event.clientX,
                ),
              ),
            }));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setResizing(false);
        }}
        onLostPointerCapture={() => setResizing(false)}
      />
    </aside>
  );
}
