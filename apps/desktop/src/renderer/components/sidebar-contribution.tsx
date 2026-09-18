import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import type {
  SidebarItemPresentation,
  SidebarSectionConfig,
  SidebarSurface,
} from "../../shared/sidebar.js";

export type SidebarContentState =
  | "loading"
  | "empty"
  | "ready"
  | "error"
  | "unavailable";
/**
 * What a section reports; the section chrome draws every status the same way.
 * Sections render rows and nothing else: no loading text, no empty copy, no
 * error paragraphs of their own.
 */
export interface SidebarStatus {
  state: SidebarContentState;
  /** Rows are on screen while a newer read is in flight. */
  refreshing?: boolean;
  /**
   * Nothing is in flight: the first read waits until the section is shown.
   * The chrome keeps the skeleton but never spins for an idle section.
   */
  idle?: boolean;
  error?: string;
  retry?: () => unknown;
  /** Default empty sentence; the section config's `empty` wins. */
  empty?: string;
}
export interface SidebarContributionContext {
  section: SidebarSectionConfig;
  surface: SidebarSurface;
  visible: boolean;
  relevant: boolean;
  status: SidebarStatus;
  report: (status: SidebarStatus) => void;
  reportItems?: (id: string, count: number | null) => void;
  open: (url: string, mode: OpenMode) => void;
  command?: (action: string) => void | Promise<void>;
  commands?: ReadonlySet<string>;
  registerRefresh?: (refresh: () => unknown) => () => void;
}
const Context = createContext<SidebarContributionContext | null>(null);
export function SidebarContribution({
  value,
  children,
}: {
  value: SidebarContributionContext;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSidebarContribution() {
  return useContext(Context);
}
export function useSidebarContent(input: SidebarContentState | SidebarStatus) {
  const report = useContext(Context)?.report;
  const status = typeof input === "string" ? { state: input } : input;
  const retry = useRef(status.retry);
  retry.current = status.retry;
  const { state, refreshing = false, idle = false, error, empty } = status;
  useEffect(() => {
    report?.({
      state,
      refreshing,
      idle,
      error,
      empty,
      retry: () => retry.current?.(),
    });
  }, [report, state, refreshing, idle, error, empty]);
}

export function sidebarItemPresentation({
  section,
  id,
}: {
  section?: SidebarSectionConfig;
  id?: string;
}): SidebarItemPresentation {
  return {
    open: section?.open,
    menu: section?.menu,
    contextMenu: section?.contextMenu,
    actions: section?.actions,
    ...section?.itemDefaults,
    ...(id ? section?.itemOverrides?.[id] : undefined),
  };
}

/** Source-independent filtering and ordering over authorized source records. */
export function projectSidebarItems<T extends object>(
  items: readonly T[],
  section?: SidebarSectionConfig,
): T[] {
  const source = section?.source;
  const read = (item: T, field: string): unknown => {
    let value: unknown = item;
    for (const part of field.split(".")) {
      if (!value || typeof value !== "object") return undefined;
      const entry = Object.entries(value).find(([key]) => key === part);
      value = entry?.[1];
    }
    return value;
  };
  const filtered = items.filter((item) =>
    Object.entries(source?.filter ?? {}).every(
      ([field, value]) => read(item, field) === value,
    ),
  );
  const sort = source?.sort;
  return sort
    ? filtered.sort((left, right) => {
        const a = read(left, sort.field);
        const b = read(right, sort.field);
        const order =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a ?? "").localeCompare(String(b ?? ""));
        return order * (sort.direction === "desc" ? -1 : 1);
      })
    : filtered;
}

/** A section owns refresh callbacks; no global synthetic focus event is needed. */
export function useSidebarRefresh(refresh: () => unknown) {
  const register = useSidebarContribution()?.registerRefresh;
  useEffect(() => register?.(refresh), [register, refresh]);
}

/** Account for the final projection, including filters and hidden item overrides. */
export function useSidebarItemCount(count: number) {
  const id = useId();
  const report = useSidebarContribution()?.reportItems;
  useEffect(() => {
    report?.(id, count);
  }, [report, id, count]);
  useEffect(() => () => report?.(id, null), [report, id]);
}
