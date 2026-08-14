import type { KeyboardEvent, ReactNode } from "react";
import { createContext, useContext, useId, useMemo, useRef } from "react";
import { cx } from "./cx.js";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context)
    throw new Error(`<${component}> must be rendered inside <Tabs>`);
  return context;
}

/**
 * Underline-style tabs, controlled. Compose:
 *
 * ```tsx
 * <Tabs value={tab} onValueChange={setTab}>
 *   <TabList>
 *     <Tab value="overview">Overview</Tab>
 *     <Tab value="activity">Activity</Tab>
 *   </TabList>
 *   <TabPanel value="overview">…</TabPanel>
 *   <TabPanel value="activity">…</TabPanel>
 * </Tabs>
 * ```
 *
 * Keyboard: roving tabIndex — only the selected tab is in the tab order;
 * Left/Right/Home/End move focus and select. Content swaps instantly, with
 * no animation: for tabs, a fade only delays the content the user asked for.
 */
export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const baseId = useId();
  const context = useMemo(
    () => ({ value, onValueChange, baseId }),
    [value, onValueChange, baseId],
  );
  return (
    <TabsContext.Provider value={context}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/** The row of {@link Tab}s. Handles arrow-key roving focus. */
export function TabList({
  children,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [],
    );
    if (tabs.length === 0) return;
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + tabs.length) % tabs.length;
    else next = (current + 1) % tabs.length;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cx("cat-tablist", className)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

/** One tab button; `value` pairs it with its {@link TabPanel}. */
export function Tab({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const context = useTabsContext("Tab");
  const selected = context.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${context.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${context.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      className={cx("cat-tab", className)}
      onClick={() => context.onValueChange(value)}
    >
      {children}
    </button>
  );
}

/** Content for one tab; renders only while its `value` is selected. */
export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const context = useTabsContext("TabPanel");
  if (context.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${context.baseId}-panel-${value}`}
      aria-labelledby={`${context.baseId}-tab-${value}`}
      className={cx("cat-tabpanel", className)}
    >
      {children}
    </div>
  );
}
