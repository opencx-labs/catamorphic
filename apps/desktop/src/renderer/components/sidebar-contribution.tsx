import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
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
export interface SidebarContributionContext {
  section: SidebarSectionConfig;
  surface: SidebarSurface;
  visible: boolean;
  relevant: boolean;
  report: (state: SidebarContentState) => void;
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
export function useSidebarContent(state: SidebarContentState) {
  const report = useContext(Context)?.report;
  useEffect(() => {
    report?.(state);
  }, [report, state]);
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
