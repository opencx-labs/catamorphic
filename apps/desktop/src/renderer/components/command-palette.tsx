import { Bot, Check, Globe, type LucideIcon, Search, Star } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ActionId,
  BUILTIN_ACTIONS,
  type KeybindingAction,
} from "../../shared/actions.js";
import type { OpenMode as CommitMode } from "../../shared/open-mode.js";
import {
  EMPTY_PALETTE_SIGNALS,
  type PaletteSignals,
  paletteCountsVisit,
} from "../../shared/palette.js";
import { normalizeCommandQuery } from "../lib/command-score.js";
import { desktopApi, projectAgentAsInfo } from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { useListMotion } from "../lib/list-motion.js";
import { pointerMoved } from "../lib/pointer-moved.js";
import { useProjectSkills } from "../lib/skills.js";
import { usePaletteHost } from "../palette/host.js";
import {
  isFullPaletteModeName,
  matchPaletteMode,
  pinCurrentFirst,
  usePaletteLoad,
} from "../palette/load.js";
import { isChoiceMode } from "../palette/modes/choices.js";
import { useTopLevelModeRows } from "../palette/modes/custom.js";
import { usePaletteModes } from "../palette/modes/index.js";
import { useProjectAgents } from "../palette/project-agents.js";
import {
  createPaletteIndex,
  frequentItems,
  PALETTE_RESULT_LIMIT,
} from "../palette/rank.js";
import { useCommandRows } from "../palette/rows/commands.js";
import { useDestinationRows } from "../palette/rows/destinations.js";
import { useHistoryRows } from "../palette/rows/history.js";
import { useResourceRows } from "../palette/rows/resources.js";
import { useSettingRows } from "../palette/rows/settings.js";
import {
  highlightedRow,
  moveHighlight,
  settleSelection,
  TOP_ROW,
} from "../palette/selection.js";
import type { PaletteItem, PaletteModeRequest } from "../palette/types.js";
import { resolveInput } from "../screens/browser-screen.js";
import { PILL_SURFACE } from "./context-pill.js";
import { OpenResourceButton } from "./open-resource-button.js";

/**
 * The command palette, in two hosts: a Cmd+P overlay above everything, and
 * the content of a "New Tab" (Cmd+T). Both read the app through the palette
 * host (palette/host.tsx); rows come from palette/rows, modes from
 * palette/modes, ranking from palette/rank (ADR 0186).
 *
 * Enter/Cmd+Enter: in the overlay, Enter opens in the current tab and
 * Cmd+Enter in a new one; in a palette tab both land in the tab itself
 * (the palette tab is consumed).
 */

/** The whole input is URL-shaped: scheme, or domain(+path) with no spaces. */
const URLISH =
  /^(https?:\/\/\S+|[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?|localhost(:\d+)?(\/\S*)?)$/i;
const LONG_QUERY = 60;
const LIST_MAX_HEIGHT = 350;

/**
 * The New Tab page's quiet cheat sheet: the workhorse shortcuts that have
 * no button anywhere in the chrome (Cmd+M, Cmd+\, Ctrl+`, …). Derived from
 * the live keybindings so a rebind updates the page. Deliberately faint —
 * furniture, not content.
 */
const NEW_TAB_HINT_ACTIONS: KeybindingAction[] = [
  "toggle-chat-minimized",
  "chat-to-tab",
  "split-view",
  "new-terminal-tab",
  "reopen-tab",
  "next-tab",
];

function NewTabShortcutHints({
  keybindings,
  actionAvailability,
}: {
  keybindings: Record<KeybindingAction, string>;
  actionAvailability?: Partial<Record<ActionId, boolean>>;
}) {
  const visibleActions = NEW_TAB_HINT_ACTIONS.filter(
    (action) => actionAvailability?.[action] !== false,
  );
  if (visibleActions.length === 0) return null;
  return (
    <div className="mt-10 grid shrink-0 grid-cols-2 gap-x-12 gap-y-2.5">
      {visibleActions.map((action) => {
        const definition = BUILTIN_ACTIONS.find((entry) => entry.id === action);
        if (!definition) return null;
        return (
          <div
            key={action}
            className="flex items-center justify-between gap-6 text-[11px] text-fg-faint"
          >
            <span>{definition.label}</span>
            <kbd className="rounded border border-border bg-bg-inset px-1.5 py-0.5 font-sans text-[10px]">
              {formatBinding(keybindings[action])}
            </kbd>
          </div>
        );
      })}
    </div>
  );
}

function FooterHint({ keycap, label }: { keycap: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-border bg-bg-inset px-1 py-px font-sans text-[10px]">
        {keycap}
      </kbd>
      {label}
    </span>
  );
}

export function CommandPalette({
  variant,
  open = true,
  onClose,
  modeRequest,
}: {
  variant: "overlay" | "tab";
  /**
   * Overlay only: stays mounted while closed so the exit transition can
   * play (unmounting kills it mid-frame). Tab variant is always open.
   */
  open?: boolean;
  /** Overlay: hide the palette. Tab: close/consume the palette tab. */
  onClose: () => void;
  /** Overlay only: open straight into a mode (agent commands, sidebar search). */
  modeRequest?: PaletteModeRequest | null;
}) {
  const {
    projectId,
    profileId,
    focusedChat,
    onSendToAgent,
    onOpenUrl,
    onHighlightTarget,
    agents,
    defaultAgentId,
    actionAvailability,
  } = usePaletteHost();
  const [query, setQuery] = useState("");
  // Stays on a chosen row while late sources re-rank the list under it.
  const [selection, setSelection] = useState(TOP_ROW);
  // The active mode by id. Modes are built further down from live data;
  // a sidebar search carries its own rows in the request.
  const [modeId, setModeId] = useState<string | null>(null);
  const [sectionSearch, setSectionSearch] = useState<Extract<
    PaletteModeRequest,
    { mode: "section" }
  > | null>(null);
  // Exiting chip lingers to play chip-out; removed on animationend.
  const [exitingChip, setExitingChip] = useState<{
    icon: LucideIcon;
    label: string;
  } | null>(null);
  const picker = modeId && isChoiceMode(modeId) ? modeId : null;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);

  const enterMode = useCallback((next: string) => {
    setModeId(next);
    setExitingChip(null);
    setQuery("");
    setSelection(TOP_ROW);
    inputRef.current?.focus();
  }, []);

  // Keep the exiting list intact, but always start a fresh opening even if
  // the user reopens before its exit animation has finished. This precedes
  // modeRequest so an explicit mode can initialize the fresh palette.
  useLayoutEffect(() => {
    const reset = () => {
      setQuery("");
      setSelection(TOP_ROW);
      setModeId(null);
      setExitingChip(null);
      listMotionRef.current.reset();
    };
    if (open) {
      reset();
      return;
    }
    const timer = setTimeout(reset, 250);
    return () => clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const cancel = () => cancelAnimationFrame(frame);
    // The tab can finish mounting behind a newly opened chat. Once another
    // interaction owns focus, this delayed frame must not take it back.
    // Overlays intentionally claim focus as soon as they open.
    if (variant === "tab") {
      window.addEventListener("focusin", cancel);
      window.addEventListener("keydown", cancel, true);
      window.addEventListener("pointerdown", cancel, true);
    }
    return () => {
      cancel();
      window.removeEventListener("focusin", cancel);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("pointerdown", cancel, true);
    };
  }, [open, variant]);

  // Commands run from anywhere open the overlay already inside their mode.
  useEffect(() => {
    if (variant !== "overlay" || !modeRequest) return;
    if (modeRequest.mode === "section") setSectionSearch(modeRequest);
    enterMode(modeRequest.mode);
  }, [variant, modeRequest, enterMode]);

  const keybindings = useKeybindings();
  // Fresh on every open, like history below: skills are files an agent or
  // collaborator may have just written. The tab variant is always "open",
  // so a new query session (empty → typing) is its refresh moment.
  const [skillsRefresh, setSkillsRefresh] = useState(0);
  const hasQuery = query.trim() !== "";
  useEffect(() => {
    if (open) setSkillsRefresh((count) => count + 1);
  }, [open]);
  useEffect(() => {
    if (hasQuery) setSkillsRefresh((count) => count + 1);
  }, [hasQuery]);
  const skills = useProjectSkills(
    projectId,
    variant === "tab" || open,
    skillsRefresh,
  );
  // Ranking signals (ADR 0186), on the same beat as skills: every opening
  // and every new query session, so use elsewhere shows up next time.
  const [signals, setSignals] = useState<PaletteSignals>(EMPTY_PALETTE_SIGNALS);
  useEffect(() => {
    if (!profileId || skillsRefresh === 0) return;
    let cancelled = false;
    void desktopApi
      .paletteSignals()
      .then((next) => {
        // Unchanged signals keep their identity, so rows do not re-rank
        // (and glide) on every opening.
        if (!cancelled)
          setSignals((current) =>
            JSON.stringify(current) === JSON.stringify(next) ? current : next,
          );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileId, skillsRefresh]);

  // A palette tab is the only thing on its page, so returning to the
  // window (Cmd+Tab, a click from another app) should land the caret in
  // the input without an extra click. Guarded on "nothing else grabbed
  // focus" so a split-pane neighbor's input is never robbed.
  useEffect(() => {
    if (variant !== "tab") return;
    const onWindowFocus = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) inputRef.current?.focus();
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [variant]);

  // Project agents refresh with skills and on every picker entry.
  const projectAgents = useProjectAgents({
    projectId,
    refresh: `${skillsRefresh}:${picker ?? ""}`,
  });
  // Skills follow the target agent's allowlist: the focused chat's agent,
  // else the default, profile or project.
  const skillAgent = [...agents, ...projectAgents.map(projectAgentAsInfo)].find(
    (agent) => agent.id === (focusedChat?.agentId ?? defaultAgentId),
  );
  const {
    actionItems,
    startingActionItems,
    skillItems,
    projectItems,
    profileItems,
    commandItems,
  } = useCommandRows({ enterMode, skills, agentSkills: skillAgent?.skills });
  const { resourceItems, bookmarkedUsage } = useResourceRows({
    active: variant === "tab" || open,
  });
  const { surfaceItems, historyPageItem } = useDestinationRows();
  const { historyRow, historyItems } = useHistoryRows({
    query,
    enabled: (variant === "tab" || open) && !modeId,
    bookmarkedUsage,
  });
  const settingItems = useSettingRows();
  const { modes, customModes } = usePaletteModes({
    picker,
    historyRow,
    settingItems,
    commandItems,
    sectionSearch,
    projectAgents,
  });
  const namedModes = useMemo(
    () => modes.filter((candidate) => candidate.names?.length),
    [modes],
  );
  const activeMode = modes.find((candidate) => candidate.id === modeId) ?? null;
  // A mode can vanish while active (workspace.js edited, project switched):
  // fall back to the ordinary palette rather than a chipless dead end.
  useEffect(() => {
    if (modeId && !activeMode) setModeId(null);
  }, [modeId, activeMode]);
  const exitMode = () => {
    if (activeMode)
      setExitingChip({ icon: activeMode.icon, label: activeMode.chip });
    setModeId(null);
  };
  const modeLoad = usePaletteLoad(
    activeMode?.rows,
    query,
    (variant === "tab" || open) && Boolean(activeMode),
  );
  const rankContext = useMemo(
    () => ({ signals, projectId }),
    [signals, projectId],
  );
  const activeRows = activeMode?.rows;
  // A source that searches shows its last answer while the next query
  // loads; those rows are ranked here against what is typed now, so the
  // top row (what Enter opens) always matches the current query.
  const staleSearch =
    activeRows?.kind === "load" && activeRows.filtered && modeLoad.loading;
  const modeItems =
    activeRows?.kind === "list"
      ? activeRows.items
      : activeRows?.kind === "load" && (!activeRows.filtered || staleSearch)
        ? modeLoad.items
        : null;
  const searchMode = useMemo(
    () => (modeItems ? createPaletteIndex(modeItems) : null),
    [modeItems],
  );
  const searchCommands = useMemo(
    () => createPaletteIndex(commandItems),
    [commandItems],
  );

  const topLevelModeRows = useTopLevelModeRows(
    customModes,
    (variant === "tab" || open) && !modeId,
  );
  // Rows everything else already lists: a bookmarked page or a workflow
  // appears once, as its own row, ranked with its history counts.
  const nativeRows = useMemo(() => {
    // A custom mode over a built-in source lists rows the palette already
    // has (the same chat, the same workflow): each row appears once.
    const rows = [
      ...actionItems,
      ...skillItems,
      ...projectItems,
      ...profileItems,
      ...resourceItems,
      ...topLevelModeRows,
      historyPageItem,
      ...surfaceItems,
    ];
    const seen = new Set<string>();
    return rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
  }, [
    actionItems,
    skillItems,
    projectItems,
    profileItems,
    resourceItems,
    topLevelModeRows,
    historyPageItem,
    surfaceItems,
  ]);
  const nativeUsage = useMemo(
    () => new Set(nativeRows.flatMap((item) => item.usage ?? [])),
    [nativeRows],
  );
  const searchEverything = useMemo(
    () =>
      createPaletteIndex([
        ...startingActionItems,
        ...nativeRows,
        ...historyItems.filter((item) => !nativeUsage.has(item.usage ?? "")),
        ...settingItems,
      ]),
    [startingActionItems, nativeRows, nativeUsage, historyItems, settingItems],
  );
  const trimmed = query.trim();
  const allResults = useMemo<PaletteItem[]>(() => {
    // Mode active: the whole input belongs to that mode's rows.
    if (activeRows) {
      const status = (label: string, retry: boolean): PaletteItem[] => [
        {
          id: `${modeId}:status`,
          icon: Search,
          label,
          detail: retry ? "Press Enter to retry" : undefined,
          keywords: [],
          kind: "action",
          commit: "stay",
          disabled: !retry,
          run: modeLoad.retry,
        },
      ];
      if (activeRows.kind === "compute") return activeRows.rows(query);
      if (activeRows.kind === "load") {
        if (modeLoad.idle) return status(activeRows.idle ?? "", false);
        if (modeLoad.error) return status(modeLoad.error, true);
        if (modeLoad.loading && !modeLoad.items.length)
          return status("Loading…", false);
        if (!modeLoad.items.length)
          return activeRows.empty ? status(activeRows.empty, false) : [];
        if (activeRows.filtered && !staleSearch) return modeLoad.items;
      }
      const items = modeItems ?? [];
      if (!trimmed)
        return activeRows.kind === "list" && activeRows.zero === "pin-current"
          ? pinCurrentFirst([...items])
          : [...items];
      return searchMode?.(trimmed, rankContext) ?? [];
    }

    // "@" zero-state: list the modes as selectable rows (Chrome's
    // @-shortcut pills). Narrows as the trigger is typed.
    if (trimmed.startsWith("@")) {
      const partial = trimmed.slice(1).toLowerCase();
      const modeRows = namedModes
        .filter((candidate) =>
          candidate.names?.some((name) => name.startsWith(partial)),
        )
        .map(
          (candidate): PaletteItem => ({
            id: `mode-row:${candidate.id}`,
            icon: candidate.icon,
            label: candidate.label ?? candidate.chip,
            detail: candidate.description,
            shortcut: "Tab",
            keywords: [],
            kind: "action",
            commit: "stay",
            run: () => enterMode(candidate.id),
          }),
        );
      if (modeRows.length > 0) return modeRows;
    }

    // ">" filters to command rows only (VS Code quick-open convention),
    // the Commands mode without its chip.
    if (trimmed.startsWith(">")) {
      const commandQuery = trimmed.slice(1).trim();
      return commandQuery
        ? searchCommands(commandQuery, rankContext)
        : commandItems;
    }

    if (!trimmed) {
      // A focused site's settings lead its zero state, like chat commands.
      const siteSettings = surfaceItems.filter(
        (item) => item.id === "site-settings",
      );
      const rest = nativeRows.filter(
        (item) =>
          item.id !== "site-settings" && !topLevelModeRows.includes(item),
      );
      const byUsage = new Map(
        nativeRows.flatMap((item) => (item.usage ? [[item.usage, item]] : [])),
      );
      const frequent = frequentItems(
        [
          ...rest,
          ...topLevelModeRows,
          ...signals.frequentHistory.map(
            (entry) => byUsage.get(entry.id) ?? historyRow(entry),
          ),
        ],
        rankContext,
      ).map((item) => ({ ...item, group: "Frequent" }));
      const taken = new Set(frequent.map((item) => item.id));
      return [
        ...startingActionItems,
        ...siteSettings,
        ...frequent,
        ...rest.filter((item) => !taken.has(item.id)),
        ...historyItems
          .filter(
            (item) => !taken.has(item.id) && !nativeUsage.has(item.usage ?? ""),
          )
          .slice(0, 8),
      ];
    }

    const scored = searchEverything(trimmed, rankContext);

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
    const urlish = URLISH.test(trimmed);
    const sendItems = projectId ? [sendItem] : [];
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

    // A pasted/typed URL is an unambiguous intent: open it. Everything
    // else (fuzzy matches on the URL's characters) is noise below it.
    if (urlish && webItem) {
      return [webItem, ...scored, ...sendItems];
    }
    if (scored.length === 0 || multiline || query.length > LONG_QUERY) {
      return [...sendItems, ...scored, ...(webItem ? [webItem] : [])];
    }
    return [...scored, ...(webItem ? [webItem] : []), ...sendItems];
  }, [
    activeRows,
    staleSearch,
    modeId,
    modeLoad,
    modeItems,
    searchMode,
    rankContext,
    namedModes,
    enterMode,
    searchCommands,
    commandItems,
    trimmed,
    query,
    startingActionItems,
    surfaceItems,
    nativeRows,
    nativeUsage,
    topLevelModeRows,
    signals.frequentHistory,
    historyRow,
    historyItems,
    searchEverything,
    projectId,
    onSendToAgent,
    onOpenUrl,
  ]);

  const results = useMemo(
    () => allResults.slice(0, PALETTE_RESULT_LIMIT),
    [allResults],
  );

  // Two-part list animation, both measured in a layout effect so targets
  // land in the SAME frame the rows change (ResizeObserver + rAF was a
  // couple frames late, eating the tween):
  //
  // 1. cmdk's animated height — the scroll container's height is a CSS
  //    variable tracking content size; a height transition tweens it.
  // 2. FLIP on surviving rows + fade-rise on new ones — the shared
  //    search-list motion in lib/list-motion (connector search uses the
  //    same hook, so every as-you-type list in the app moves alike).
  // biome-ignore lint/correctness/useExhaustiveDependencies: results is the "rows changed" signal; the refs are stable
  useLayoutEffect(() => {
    const list = listRef.current;
    const sizer = sizerRef.current;
    if (!list || !sizer) return;
    // Clamp to the visible max — animating toward the unclamped content
    // height would spend most of the tween past the max-h cutoff.
    const height = Math.min(sizer.offsetHeight, LIST_MAX_HEIGHT);
    list.style.setProperty("--palette-list-height", `${height}px`);
  }, [results]);
  // Colors stay in the list so the selection fade keeps working while
  // (and after) a row glides. First paint of the palette skips per-row
  // enters: the panel's own enter animation covers it.
  const listMotion = useListMotion(sizerRef, results, {
    keepTransitions: "background-color 100ms, color 100ms",
  });
  const listMotionRef = useRef(listMotion);
  listMotionRef.current = listMotion;

  const selected = highlightedRow(selection, results);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  // Rows changed: follow a chosen row to its new place, or give up a
  // choice whose row left the list.
  useLayoutEffect(() => {
    setSelection((current) => settleSelection(current, results));
  }, [results]);
  // A chosen row stays in view, whether an arrow key moved the highlight
  // or a re-rank moved the row.
  const chosenId = selection.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected is the "row moved" signal
  useEffect(() => {
    if (!chosenId) return;
    // Group labels and notices share the list, so find the row itself.
    sizerRef.current
      ?.querySelector(`[data-item-id="${CSS.escape(chosenId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [chosenId, selected]);

  // The surface the highlighted row (or the open question) acts on,
  // reported up so the app accents its border.
  const highlight =
    variant === "overlay" && !open
      ? undefined
      : (activeMode?.highlight ?? results[selected]?.highlight);
  const highlightTarget: "chat" | "close" | null =
    highlight === "chat-if-focused"
      ? focusedChat
        ? "chat"
        : null
      : (highlight ?? null);
  const onHighlightTargetRef = useRef(onHighlightTarget);
  onHighlightTargetRef.current = onHighlightTarget;
  useEffect(() => {
    onHighlightTargetRef.current?.(highlightTarget);
    return () => onHighlightTargetRef.current?.(null);
  }, [highlightTarget]);

  // What the palette learns from a pick (ADR 0186): the typed query, and a
  // visit for destinations nothing else counts.
  const record = (item: PaletteItem) => {
    const key = item.usage;
    if (!key || !profileId) return;
    // Keyed exactly as the ranker looks picks up ("gpt-4o" → "gpt 4o").
    const typed = normalizeCommandQuery(
      trimmed.startsWith(">") ? trimmed.slice(1) : trimmed,
    ).trim();
    const use = {
      key,
      ...(typed ? { query: typed } : {}),
      visit: paletteCountsVisit(key),
      ...(projectId ? { projectId } : {}),
    };
    // Incognito chats stay out of what the palette remembers, as they
    // stay out of history.
    const chat = key.startsWith('["chat",') ? item.id.slice(8) : null;
    void (
      chat && item.id.startsWith("session:")
        ? desktopApi.sessionIsIncognito(chat)
        : Promise.resolve(false)
    )
      .then((incognito) => {
        if (!incognito) return desktopApi.paletteRecord(use);
      })
      .catch(() => {});
  };

  const commit = (
    item: PaletteItem,
    withCmd: boolean,
    withShift = false,
    floating = false,
  ) => {
    // Disabled rows (invalid project agents) are informational only.
    if (item.disabled) return;
    // Entering a mode, retrying a load: palette state changes in place.
    if (item.commit === "stay") {
      item.run("replace");
      return;
    }
    // Answering a mode's question runs it and puts the palette away.
    if (item.commit === "answer") {
      if (variant === "overlay") onClose();
      item.run("replace");
      exitMode();
      return;
    }
    const inTab = variant === "tab";
    const commitMode: CommitMode = floating
      ? "floating"
      : withCmd && withShift
        ? "side"
        : inTab || withCmd
          ? "tab"
          : "replace";
    if (variant === "overlay") onClose();
    item.run(commitMode);
    record(item);
    // A palette tab is consumed by whatever it opened; pure actions
    // (toggle sidebar, …) leave it in place.
    if (inTab && item.kind === "navigate") onClose();
  };

  const moveSelection = (delta: number) => {
    setSelection((current) =>
      moveHighlight(current, resultsRef.current, delta),
    );
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Tab or Space commits a typed mode trigger into a chip ("@agent" →
    // [Ask agent]). Both keys, deliberately — Chrome removed Space once
    // and had to bring it back.
    if (
      !activeMode &&
      (event.key === "Tab" || event.key === " ") &&
      trimmed.length > 1 &&
      (trimmed.startsWith("@") || isFullPaletteModeName(namedModes, trimmed))
    ) {
      const candidate = matchPaletteMode(namedModes, trimmed);
      if (candidate) {
        event.preventDefault();
        enterMode(candidate.id);
        return;
      }
    }
    // Backspace on empty input pops the chip (cmdk convention).
    if (activeMode && event.key === "Backspace" && query === "") {
      event.preventDefault();
      exitMode();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (
      event.key === "Enter" &&
      (!event.shiftKey ||
        (/Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey))
    ) {
      // Shift+Enter alone stays a newline; ⌘⇧↵ is the side commit.
      event.preventDefault();
      const item = results[selected];
      if (item) {
        commit(
          item,
          /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey,
          event.shiftKey,
          event.altKey && !event.metaKey && !event.ctrlKey,
        );
      }
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

  // The rendered chip: the live mode, or the exiting one mid chip-out.
  const chip = activeMode
    ? { icon: activeMode.icon, label: activeMode.chip, live: true }
    : exitingChip
      ? { ...exitingChip, live: false }
      : null;

  const panel = (
    <div
      role="dialog"
      aria-label="Command palette"
      className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-raised shadow-2xl"
    >
      <div className="mx-3 flex items-start gap-2 border-b border-border">
        {chip && (
          <span
            data-testid={chip.live ? "palette-mode-chip" : undefined}
            onAnimationEnd={(event) => {
              if (event.animationName === "chip-out") setExitingChip(null);
            }}
            className={`mt-[9px] flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap py-1 pl-1.5 pr-2 ${PILL_SURFACE} ${
              chip.live ? "animate-chip-in" : "animate-chip-out"
            }`}
          >
            <chip.icon className="size-3.5 shrink-0" />
            {chip.label}
          </span>
        )}
        <textarea
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelection(TOP_ROW);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={onInputKeyDown}
          rows={1}
          spellCheck={false}
          placeholder={activeMode?.placeholder ?? "Search or ask anything…"}
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
          {activeMode && modeLoad.notice && (
            <p role="status" className="px-4 py-2 text-xs text-fg-muted">
              {modeLoad.notice}
            </p>
          )}
          {results.map((item, index) => {
            const Icon = item.icon;
            const isSelected = index === selected;
            // Scope labels ("Project agents") render above the first row
            // of a group. Plain divs without data-item-id, so the FLIP
            // machinery ignores them.
            const groupLabel =
              item.group && item.group !== results[index - 1]?.group
                ? item.group
                : null;
            return (
              <Fragment key={item.id}>
                {groupLabel && (
                  <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-fg-faint">
                    {groupLabel}
                  </div>
                )}
                <OpenResourceButton
                  isResource={item.kind === "navigate"}
                  openOnMouseDown
                  data-item-id={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={item.disabled || undefined}
                  data-disabled-reason={item.disabled ? item.detail : undefined}
                  onOpen={(mode) =>
                    commit(
                      item,
                      mode === "tab" || mode === "side",
                      mode === "side",
                      mode === "floating",
                    )
                  }
                  // mousedown so the textarea's focus never flickers away.
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                  }}
                  onMouseMove={(event) => {
                    if (pointerMoved(event))
                      setSelection({ index, id: item.id });
                  }}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-100 ${
                    item.disabled
                      ? "cursor-default opacity-50"
                      : "cursor-pointer"
                  } ${isSelected ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
                >
                  {item.iconNode ?? (
                    <Icon className="size-4 shrink-0 text-fg-faint" />
                  )}
                  <span className="min-w-0 truncate">{item.label}</span>
                  {/* A long label truncates before a short detail ("Chat",
                      "Workflow"); a long detail keeps at most half the row. */}
                  {item.detail && (
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[12px] text-fg-faint">
                      {item.detail}
                    </span>
                  )}
                  {(item.bookmarked || item.current || item.shortcut) && (
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-fg-faint">
                      {item.bookmarked && (
                        <Star
                          className="size-3.5 fill-current"
                          aria-label="Bookmarked"
                        />
                      )}
                      {item.current && (
                        <span
                          className="flex items-center gap-1"
                          data-testid="palette-current"
                        >
                          <Check className="size-3.5" />
                          current
                        </span>
                      )}
                      {item.shortcut && (
                        <kbd className="rounded border border-border bg-bg-inset px-1.5 py-0.5 text-[11px] text-fg-faint">
                          {item.shortcut}
                        </kbd>
                      )}
                    </span>
                  )}
                </OpenResourceButton>
              </Fragment>
            );
          })}
          {results.length === 0 && (
            <p className="py-6 text-center text-xs text-fg-faint">
              Nothing here yet.
            </p>
          )}
        </div>
      </div>
      {/* Footer hint bar (Raycast pattern): the modes' discoverability
          surface. Backspace hint replaces the entry hints while chipped. */}
      <footer
        data-testid="palette-footer"
        className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-1.5 text-[11px] text-fg-faint"
      >
        {activeMode ? (
          <FooterHint keycap="⌫" label="exit mode" />
        ) : (
          <>
            <FooterHint keycap="@" label="modes" />
            <FooterHint keycap=">" label="commands" />
          </>
        )}
        <span className="ml-auto" />
        <FooterHint keycap="↵" label="open" />
        <FooterHint keycap="⌘↵" label="new tab" />
        <FooterHint keycap="⌘⇧↵" label="side" />
        <FooterHint keycap="⌥↵" label="floating" />
      </footer>
    </div>
  );

  if (variant === "tab") {
    return (
      // items-center (not stretch): stretch would pull the panel to full
      // height — footer floating mid-card above a giant empty body
      // (invisible in dark themes, glaring in light).
      //
      // The page is the palette: clicking anywhere outside the panel puts
      // the caret back in the input (mousedown + preventDefault so focus
      // never leaves in the first place) — there is nothing else on this
      // page to focus.
      // biome-ignore lint/a11y/noStaticElementInteractions: background click-to-refocus; the input itself stays keyboard-reachable
      <div
        className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-6 pt-[12vh]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {panel}
        <NewTabShortcutHints
          keybindings={keybindings}
          actionAvailability={actionAvailability}
        />
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
      {/* The wrapper spans the full width to center the panel; it must not
          eat clicks beside the panel (the panel re-enables pointer events),
          or click-away only worked above/below the panel's vertical band. */}
      <div
        className={`pointer-events-none relative flex w-full origin-top justify-center transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
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
