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
  SidebarMenuEntry,
  SidebarSectionConfig,
  SidebarSurface,
} from "../../shared/sidebar.js";
import type { SidebarSourceSession } from "../../shared/sidebar-source.js";
import type { SourceAccess } from "../sources/contract.js";

export type SidebarContentState =
  | "loading"
  | "empty"
  | "ready"
  | "error"
  | "unavailable"
  /** Its module wants more than the person allowed (ADR 0277). */
  | "access";
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
  /**
   * Its source takes drops: empty, the section draws its own empty
   * sentence as the place to drop, so the chrome draws none.
   */
  droppable?: boolean;
  /** What its module asks before it runs, with state "access". */
  access?: SourceAccess;
}
export interface SidebarContributionContext {
  section: SidebarSectionConfig;
  surface: SidebarSurface;
  visible: boolean;
  relevant: boolean;
  /**
   * Hidden only for being empty, on screen otherwise: it keeps reading
   * its first rows so it can come back.
   */
  observeEmpty?: boolean;
  status: SidebarStatus;
  report: (status: SidebarStatus) => void;
  reportItems?: (id: string, count: number | null) => void;
  /** Open a workspace target as this section opens links. */
  open: (url: string, mode: OpenMode) => void;
  /** Work's own verbs on the section: refresh and search. */
  command?: (action: string) => void | Promise<void>;
  commands?: ReadonlySet<string>;
  /** Run one of the section's header actions (ADR 0234). */
  runHeader?: (entry: SidebarMenuEntry) => Promise<void>;
  /** The chat a chat-scoped section shows, for its header actions. */
  chat?: { current?: SidebarSourceSession };
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
  const {
    state,
    refreshing = false,
    idle = false,
    error,
    empty,
    droppable = false,
    access,
  } = status;
  const asking = access?.request.fingerprint;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request's fingerprint names it; a new object for the same request is not a change.
  useEffect(() => {
    report?.({
      state,
      refreshing,
      idle,
      error,
      empty,
      droppable,
      ...(access ? { access } : {}),
      retry: () => retry.current?.(),
    });
  }, [report, state, refreshing, idle, error, empty, droppable, asking]);
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
