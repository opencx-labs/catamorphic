import * as icons from "lucide-react";
import { Circle, Plus } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  SidebarSectionConfig,
  SidebarSide,
  SidebarSurface,
  SidebarTabConfig,
} from "../../shared/sidebar.js";
import { matchesSidebarSurface } from "../../shared/sidebar.js";
import { ShortcutHint } from "./shortcut-hint.js";
import type { SidebarContentState } from "./sidebar-contribution.js";

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
  tabs: configuredTabs,
  surface = { kind: "none" },
  open,
  scope,
  header,
  headerActions,
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
  surface?: SidebarSurface;
  open: boolean;
  scope: string;
  header?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  error?: string;
  onCustomize: () => void;
  renderSection: (
    section: SidebarSectionConfig,
    visible: boolean,
    report: (state: SidebarContentState) => void,
    relevant: boolean,
  ) => ReactNode;
}) {
  const storageKey = `catamorphic:sidebar:${scope}:${side}`;
  const [layout, setLayout] = useState(() => readLayout(storageKey, side));
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [resizing, setResizing] = useState(false);
  const [tabMotion, setTabMotion] = useState(false);
  const root = useRef<HTMLElement>(null);
  const id = useId();
  const [content, setContent] = useState<
    ReadonlyMap<string, SidebarContentState>
  >(new Map());
  const report = useCallback((id: string, state: SidebarContentState) => {
    setContent((current) =>
      current.get(id) === state ? current : new Map(current).set(id, state),
    );
  }, []);
  const sectionRelevant = (section: SidebarSectionConfig) =>
    matchesSidebarSurface(section.when, surface) &&
    (((section.source?.type ?? section.type) !== "subsessions" &&
      (!section.source?.scope || section.source.scope === "project")) ||
      (surface.kind === "chat" && Boolean(surface.sessionId)));
  const sectionAvailable = (section: SidebarSectionConfig) => {
    if (!sectionRelevant(section)) return false;
    const state = content.get(section.id);
    const hideEmpty =
      section.hideEmpty ??
      ["workflows", "apps", "git", "remote", "subsessions"].includes(
        section.source?.type ?? section.type,
      );
    return state !== "unavailable" && !(hideEmpty && state === "empty");
  };
  const tabs = configuredTabs.filter(
    (tab) =>
      matchesSidebarSurface(tab.when, surface) &&
      tab.sections.some(sectionAvailable),
  );
  const selected =
    tabs.find((tab) => tab.id === layout.selected)?.id ?? tabs[0]?.id;
  const previousSelected = useRef(selected);
  const focusWithin = useRef(false);
  useLayoutEffect(() => {
    if (
      previousSelected.current !== selected &&
      focusWithin.current &&
      selected
    ) {
      (
        document.getElementById(`${id}-tab-${selected}`) ??
        document.getElementById(`${id}-panel-${selected}`)
      )?.focus();
    }
    previousSelected.current = selected;
  }, [selected, id]);
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
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node)
          focusWithin.current = Boolean(
            root.current?.contains(event.relatedTarget),
          );
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
        {(tabs.length > 1 || headerActions) && (
          <div className="flex h-10 shrink-0 items-center gap-2 px-2">
            {headerActions}
            <div
              role="tablist"
              aria-label={`${side === "left" ? "Left" : "Right"} sidebar tabs`}
              className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto"
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
          {configuredTabs.map((tab) => (
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
              {tab.sections.map((section) => (
                <SidebarSlot
                  key={section.id}
                  section={section}
                  mounted={
                    visited.has(tab.id) ||
                    (open && selected === tab.id) ||
                    section.type !== "app"
                  }
                  relevant={
                    matchesSidebarSurface(tab.when, surface) &&
                    sectionRelevant(section)
                  }
                  available={sectionAvailable(section)}
                  visible={open && selected === tab.id}
                  report={report}
                  renderSection={renderSection}
                />
              ))}
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="grid h-full place-items-center p-4">
              <button
                type="button"
                onClick={onCustomize}
                aria-label="Customize sidebar"
                className="mx-auto flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-4 text-[13px] text-fg-muted transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Plus className="size-4" aria-hidden="true" />
                Customize sidebar
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

function SidebarSlot({
  section,
  mounted,
  relevant,
  available,
  visible,
  report,
  renderSection,
}: {
  section: SidebarSectionConfig;
  mounted: boolean;
  relevant: boolean;
  available: boolean;
  visible: boolean;
  report: (id: string, state: SidebarContentState) => void;
  renderSection: (
    section: SidebarSectionConfig,
    visible: boolean,
    report: (state: SidebarContentState) => void,
    relevant: boolean,
  ) => ReactNode;
}) {
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (mounted && relevant) setVisited(true);
  }, [mounted, relevant]);
  const onState = useCallback(
    (state: SidebarContentState) => report(section.id, state),
    [report, section.id],
  );
  return (
    <div
      data-sidebar-widget={section.id}
      hidden={!available}
      inert={!available}
    >
      {(visited || (mounted && relevant)) &&
        renderSection(section, visible && relevant, onState, relevant)}
    </div>
  );
}
