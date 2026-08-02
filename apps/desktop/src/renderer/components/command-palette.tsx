import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import { useAgentSessions, useWorkflows } from "@catamorphic/react";
import {
  ArrowRight,
  Bot,
  Globe,
  LayoutGrid,
  type LucideIcon,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  Search,
  Settings as SettingsIcon,
  Star,
  UserRound,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react";
import * as lucide from "lucide-react";
import {
  type ActionDefinition,
  type ActionId,
  BUILTIN_ACTIONS,
  type KeybindingAction,
} from "../../shared/actions.js";
import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { commandScore } from "../lib/command-score.js";
import {
  type Bookmark,
  desktopApi,
  type Profile,
  type SidebarConfig,
} from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { resolveInput } from "../screens/browser-screen.js";
import { useApps } from "../screens/app-screen.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/**
 * The command palette, in two hosts: a Cmd+P overlay above everything, and
 * the content of a "New Tab" (Cmd+T). Matching is Superhuman's
 * command-score over label + keywords — the same algorithm cmdk uses, so
 * subsequences ("gto proj") and synonyms both hit.
 *
 * Enter/Cmd+Enter: in the overlay, Enter opens in the current tab and
 * Cmd+Enter in a new one; in a palette tab both land in the tab itself
 * (the palette tab is consumed).
 */

type CommitMode = "replace" | "tab";

/**
 * Icons stay renderer-side (the shared registry is plain data usable by
 * the main process). Unknown ids — e.g. future plugin actions — fall back
 * to Zap.
 */
const ACTION_ICONS: Partial<Record<ActionId, LucideIcon>> = {
  "new-floating-chat": MessageSquarePlus,
  "new-browser-tab": Globe,
  "toggle-sidebar": PanelLeft,
  "close-tab": X,
};

interface PaletteItem {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Muted inline text, e.g. a URL host or the item's type. */
  detail?: string;
  keywords: string[];
  /** Preformatted chip, e.g. "⌘B". */
  shortcut?: string;
  /** Navigate items load something tab-shaped and honor the commit mode. */
  kind: "action" | "navigate";
  run: (mode: CommitMode) => void;
}

const URLISH = /^[\w-]+(\.[\w-]+)+/;
const LONG_QUERY = 60;
const LIST_MAX_HEIGHT = 350;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const bareUrl = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/, "");

const lucideIcon = (name: string | undefined): LucideIcon => {
  if (!name) return Globe;
  const icon = (lucide as unknown as Record<string, LucideIcon>)[name];
  return icon ?? Globe;
};

export function CommandPalette({
  variant,
  open = true,
  onClose,
  projectId,
  profileId,
  projects,
  activeProjectId,
  profiles,
  activeProfileId,
  sidebarConfig,
  onOpenUrl,
  onOpenTab,
  onOpenSession,
  onSelectProject,
  onSwitchProfile,
  onSendToAgent,
  actionHandlers,
}: {
  variant: "overlay" | "tab";
  /**
   * Overlay only: stays mounted while closed so the exit transition can
   * play (unmounting kills it mid-frame). Tab variant is always open.
   */
  open?: boolean;
  /** Overlay: hide the palette. Tab: close/consume the palette tab. */
  onClose: () => void;
  projectId: string;
  profileId?: string;
  projects: ProjectSummary[];
  activeProjectId?: string;
  profiles: Profile[];
  activeProfileId?: string;
  sidebarConfig: SidebarConfig | null;
  onOpenUrl: (url: string, mode: CommitMode) => void;
  onOpenTab: (tab: WorkspaceTab) => void;
  onOpenSession: (session: AgentSession) => void;
  onSelectProject: (id: string) => void;
  onSwitchProfile: (profile: Profile) => void;
  onSendToAgent: (message: string, mode: "float" | "tab") => void;
  /** One handler per registry action — the same map the shortcuts use. */
  actionHandlers: Record<ActionId, () => void>;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);

  const keybindings = useKeybindings();

  const workflows = useWorkflows(projectId).data ?? [];
  const apps = useApps(projectId).data ?? [];
  const sessions = useAgentSessions(projectId).data?.items ?? [];

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
      if (!cancelled) {
        setBookmarks([...data.pinned, ...data.project.bookmarks]);
      }
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.projectId === projectId && change.profileId === profileId) {
        setBookmarks([...change.pinned, ...change.project.bookmarks]);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  // Refetched on every open — the overlay stays mounted while closed, so
  // a mount-only fetch would serve stale history forever.
  const [history, setHistory] = useState<{ url: string; title: string }[]>([]);
  useEffect(() => {
    if (!profileId || !open) return;
    let cancelled = false;
    void desktopApi
      .browserRecentHistory({ profileId, limit: 150 })
      .then((entries) => {
        if (!cancelled) setHistory(entries);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, open]);

  // Focus on open; reset the query after the exit transition so the list
  // doesn't visibly re-expand while the panel is still fading out (the
  // opencx trick, minus their 500ms — ours matches the 200ms transition).
  useEffect(() => {
    if (open) {
      // rAF waits out the `inert` removal — focus() no-ops on inert trees.
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(() => {
      setQuery("");
      setSelectedIndex(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [open]);

  // Action rows come straight from the shared registry — one entry there
  // yields the shortcut, the Settings row, the agent doc, and this row.
  // Handlers are read through a ref: the map is rebuilt every app render
  // (closures over fresh state), and letting it invalidate this memo
  // would cascade into the results memo and the FLIP pass per render.
  const actionHandlersRef = useRef(actionHandlers);
  actionHandlersRef.current = actionHandlers;
  const actionItems = useMemo<PaletteItem[]>(
    () =>
      BUILTIN_ACTIONS.filter(
        (action: ActionDefinition) => !action.hiddenInPalette,
      ).map(
        (action) => ({
          id: `action:${action.id}`,
          icon: ACTION_ICONS[action.id] ?? Zap,
          label: action.label,
          keywords: [...action.keywords],
          shortcut:
            action.id in keybindings
              ? formatBinding(keybindings[action.id as KeybindingAction])
              : undefined,
          kind: "action" as const,
          run: () => actionHandlersRef.current[action.id](),
        }),
      ),
    [keybindings],
  );

  const projectItems = useMemo<PaletteItem[]>(
    () =>
      projects
        .filter((project) => project.id !== activeProjectId)
        .map((project) => ({
          id: `project:${project.id}`,
          icon: ArrowRight,
          label: `Go to ${project.name}`,
          detail: "Project",
          keywords: [project.name, "go to", "project", "switch", "open"],
          kind: "action" as const,
          run: () => onSelectProject(project.id),
        })),
    [projects, activeProjectId, onSelectProject],
  );

  const profileItems = useMemo<PaletteItem[]>(
    () =>
      profiles
        .filter((profile) => profile.id !== activeProfileId)
        .map((profile) => ({
          id: `profile:${profile.id}`,
          icon: UserRound,
          label: `Switch to ${profile.name}`,
          detail: "Profile",
          keywords: [profile.name, "switch to", "profile", "account"],
          kind: "action" as const,
          run: () => onSwitchProfile(profile),
        })),
    [profiles, activeProfileId, onSwitchProfile],
  );

  const sidebarItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const workflow of workflows) {
      const label = workflow.displayName ?? workflow.name;
      items.push({
        id: `workflow:${workflow.name}`,
        icon: WorkflowIcon,
        label,
        detail: "Workflow",
        keywords: [workflow.name, "workflow", "go to", "open"],
        kind: "navigate",
        run: () =>
          onOpenTab({ kind: "workflow", name: workflow.name, label }),
      });
    }
    for (const app of apps) {
      items.push({
        id: `app:${app.name}`,
        icon: LayoutGrid,
        label: app.name,
        detail: "App",
        keywords: [app.name, "app", "go to", "open"],
        kind: "navigate",
        run: () => onOpenTab({ kind: "app", name: app.name }),
      });
    }
    for (const session of sessions) {
      if (!session.title) continue;
      items.push({
        id: `session:${session.id}`,
        icon: MessageSquare,
        label: session.title,
        detail: "Chat",
        keywords: [session.title, "chat", "session", "conversation"],
        kind: "navigate",
        run: () => onOpenSession(session),
      });
    }
    for (const bookmark of bookmarks) {
      items.push({
        id: `bookmark:${bookmark.id}`,
        icon: Star,
        label: bookmark.label,
        detail: hostOf(bookmark.url),
        keywords: [bookmark.label, hostOf(bookmark.url), bareUrl(bookmark.url), "bookmark"],
        kind: "navigate",
        run: (mode) => onOpenUrl(bookmark.url, mode),
      });
    }
    for (const section of sidebarConfig?.sections ?? []) {
      if (section.type !== "custom") continue;
      for (const item of section.items ?? []) {
        items.push({
          id: `custom:${item.label}:${item.url}`,
          icon: lucideIcon(item.icon),
          label: item.label,
          detail: hostOf(item.url),
          keywords: [item.label, hostOf(item.url), bareUrl(item.url), "link"],
          kind: "navigate",
          run: (mode) => onOpenUrl(item.url, mode),
        });
      }
    }
    items.push({
      id: "tab:settings",
      icon: SettingsIcon,
      label: "Settings",
      detail: "Open settings",
      keywords: ["settings", "preferences", "shortcuts", "theme", "keys"],
      kind: "navigate",
      run: () =>
        onOpenTab({ kind: "settings", name: "settings", label: "Settings" }),
    });
    return items;
  }, [workflows, apps, sessions, bookmarks, sidebarConfig, onOpenTab, onOpenSession, onOpenUrl]);

  const historyItems = useMemo<PaletteItem[]>(
    () =>
      history.map((entry) => ({
        id: `history:${entry.url}`,
        icon: Globe,
        label: entry.title || entry.url,
        detail: hostOf(entry.url),
        keywords: [entry.title, hostOf(entry.url), bareUrl(entry.url)],
        kind: "navigate" as const,
        run: (mode) => onOpenUrl(entry.url, mode),
      })),
    [history, onOpenUrl],
  );

  const trimmed = query.trim();
  const results = useMemo<PaletteItem[]>(() => {
    if (!trimmed) {
      return [
        ...actionItems,
        ...projectItems,
        ...profileItems,
        ...sidebarItems,
        ...historyItems.slice(0, 8),
      ];
    }

    const scored = [
      ...actionItems,
      ...projectItems,
      ...profileItems,
      ...sidebarItems,
      ...historyItems,
    ]
      .map((item) => ({
        item,
        score: commandScore(
          item.label,
          trimmed,
          item.keywords.filter((keyword) => keyword.trim() !== ""),
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

    const multiline = query.includes("\n");
    const sendItem: PaletteItem = {
      id: "send-to-agent",
      icon: Bot,
      label: "Send to agent",
      detail: "Start a chat with this message",
      keywords: [],
      kind: "navigate",
      run: (mode) => onSendToAgent(query, mode === "tab" ? "tab" : "float"),
    };
    const urlish = URLISH.test(trimmed) || /^https?:/i.test(trimmed);
    const webItem: PaletteItem | null = multiline
      ? null
      : {
          id: "web",
          icon: urlish ? Globe : Search,
          label: urlish ? `Open ${trimmed}` : `Search the web for "${trimmed}"`,
          detail: urlish ? undefined : "Google Search",
          keywords: [],
          kind: "navigate",
          run: (mode) => onOpenUrl(resolveInput(trimmed), mode),
        };

    if (scored.length === 0 || multiline || query.length > LONG_QUERY) {
      return [sendItem, ...scored, ...(webItem ? [webItem] : [])];
    }
    return [...scored, ...(webItem ? [webItem] : []), sendItem];
  }, [
    trimmed,
    query,
    actionItems,
    projectItems,
    profileItems,
    sidebarItems,
    historyItems,
    onSendToAgent,
    onOpenUrl,
  ]);

  // Two-part list animation, both measured in a layout effect so targets
  // land in the SAME frame the rows change (ResizeObserver + rAF was a
  // couple frames late, eating the tween):
  //
  // 1. cmdk's animated height — the scroll container's height is a CSS
  //    variable tracking content size; a height transition tweens it.
  // 2. FLIP on surviving rows — filtering doesn't remove rows from the
  //    edges, it removes them from the middle, so survivors teleport up
  //    to fill the holes and only the bottom gap animates. That reads as
  //    a snap even with the height tween working. So: record each row's
  //    top before render (keyed by item id), and on change play the
  //    old→new delta as a transform that eases to zero.
  const rowTopsRef = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: row heights
  // are fixed, so results is the only thing that moves or resizes rows.
  useLayoutEffect(() => {
    const list = listRef.current;
    const sizer = sizerRef.current;
    if (!list || !sizer) return;
    // Clamp to the visible max — animating toward the unclamped content
    // height would spend most of the tween past the max-h cutoff.
    const height = Math.min(sizer.offsetHeight, LIST_MAX_HEIGHT);
    list.style.setProperty("--palette-list-height", `${height}px`);

    // Read phase, then write phase — interleaving offsetTop reads with
    // style writes forces a reflow per row (measured as a multi-hundred-ms
    // main-thread stall on large lists).
    const previousTops = rowTopsRef.current;
    const nextTops = new Map<string, number>();
    const rows: { row: HTMLElement; delta: number }[] = [];
    for (const node of sizer.children) {
      const row = node as HTMLElement;
      const id = row.dataset.itemId;
      if (!id) continue;
      const top = row.offsetTop;
      nextTops.set(id, top);
      const before = previousTops.get(id);
      if (before === undefined) {
        rows.push({ row, delta: 0 });
        continue;
      }
      // A keystroke can land mid-glide; the row's true visual position is
      // its old layout spot PLUS the in-flight transform. Starting the new
      // glide from the raw layout delta would teleport it backwards.
      const matrix = new DOMMatrixReadOnly(getComputedStyle(row).transform);
      const delta = before + matrix.m42 - top;
      rows.push({ row, delta: Math.round(delta) });
    }
    rowTopsRef.current = nextTops;
    for (const { row, delta } of rows) {
      if (delta) {
        // FLIP: jump to the old position without animating the jump.
        row.style.transition = "none";
        row.style.transform = `translateY(${delta}px)`;
      } else {
        // Back to the class transition (transition-colors) untouched.
        row.style.transition = "";
        row.style.transform = "";
      }
    }
    if (rows.some(({ delta }) => delta)) {
      requestAnimationFrame(() => {
        for (const { row, delta } of rows) {
          if (!delta) continue;
          // Colors stay in the list so the selection fade keeps working
          // while (and after) the row glides.
          row.style.transition =
            "transform 200ms cubic-bezier(0.2, 0, 0, 1), background-color 100ms, color 100ms";
          row.style.transform = "";
        }
      });
    }
  }, [results]);

  const selected = Math.min(selectedIndex, Math.max(results.length - 1, 0));

  const commit = (item: PaletteItem, withCmd: boolean) => {
    const inTab = variant === "tab";
    const mode: CommitMode = inTab || withCmd ? "tab" : "replace";
    if (variant === "overlay") onClose();
    item.run(mode);
    // A palette tab is consumed by whatever it opened; pure actions
    // (toggle sidebar, …) leave it in place.
    if (inTab && item.kind === "navigate") onClose();
  };

  const moveSelection = (delta: number) => {
    setSelectedIndex((current) => {
      const next = Math.min(
        Math.max(Math.min(current, results.length - 1) + delta, 0),
        results.length - 1,
      );
      requestAnimationFrame(() => {
        sizerRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
      });
      return next;
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const item = results[selected];
      if (item) commit(item, event.metaKey || event.ctrlKey);
    }
  };

  // Escape closes the overlay (capture-phase so the chat dock's window
  // listener defers to us — same etiquette as Modal). A palette tab
  // ignores Escape, like Chrome's New Tab page.
  useEffect(() => {
    if (variant !== "overlay" || !open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [variant, open, onClose]);

  const panel = (
    <div
      role="dialog"
      aria-label="Command palette"
      className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-raised/95 drop-shadow-2xl backdrop-blur-xl"
    >
      <div className="mx-3 border-b border-border">
        <textarea
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={onInputKeyDown}
          rows={1}
          spellCheck={false}
          placeholder="Search or ask anything…"
          aria-label="Search commands, pages, and more"
          className="field-sizing-content max-h-40 w-full resize-none bg-transparent px-1 py-3 text-sm outline-none placeholder:text-fg-faint"
          style={{ outline: "none" }}
        />
      </div>
      <div
        ref={listRef}
        className="h-(--palette-list-height) max-h-[350px] overflow-y-auto overscroll-contain transition-[height] duration-250 ease-[cubic-bezier(0.2,0,0,1)]"
        role="listbox"
        aria-label="Results"
      >
        <div ref={sizerRef} className="p-2">
        {results.map((item, index) => {
          const Icon = item.icon;
          const isSelected = index === selected;
          return (
            <button
              key={item.id}
              data-item-id={item.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              // mousedown so the textarea's focus never flickers away.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(item, event.metaKey);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-100 ${
                isSelected ? "bg-bg-overlay text-fg" : "text-fg-muted"
              }`}
            >
              <Icon className="size-4 shrink-0 text-fg-faint" />
              <span className="truncate">{item.label}</span>
              {item.detail && (
                <span className="min-w-0 truncate text-[12px] text-fg-faint">
                  {item.detail}
                </span>
              )}
              {item.shortcut && (
                <kbd className="ml-auto shrink-0 rounded border border-border bg-bg-inset px-1.5 py-0.5 text-[11px] text-fg-faint">
                  {item.shortcut}
                </kbd>
              )}
            </button>
          );
        })}
        {results.length === 0 && (
          <p className="py-6 text-center text-xs text-fg-faint">
            Nothing here yet.
          </p>
        )}
        </div>
      </div>
    </div>
  );

  if (variant === "tab") {
    return (
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pt-[12vh]">
        {panel}
      </div>
    );
  }

  // Transition-based enter/exit (not one-shot keyframes): the component
  // stays mounted while closed so Cmd+P/Escape play the same motion in
  // reverse — scale + rise + fade, the chat dock's vocabulary.
  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center px-6 pt-[15vh] ${
        open ? "" : "pointer-events-none"
      }`}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; Escape covers keyboard */}
      <div
        className={`absolute inset-0 bg-black/25 transition-opacity duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div
        className={`relative flex w-full origin-top justify-center transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open
            ? "translate-y-0 scale-100 opacity-100"
            : "-translate-y-2 scale-[0.98] opacity-0"
        }`}
      >
        {panel}
      </div>
    </div>
  );
}
