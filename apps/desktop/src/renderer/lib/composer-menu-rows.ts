import type { AgentTextAttachment } from "@catamorphic/react";
import {
  useAgentSessions,
  useCatamorphic,
  useWorkflows,
} from "@catamorphic/react";
import { useQuery } from "@tanstack/react-query";
import {
  FileCode,
  FileText,
  Folder,
  Globe,
  LayoutGrid,
  LoaderCircle,
  type LucideIcon,
  MessageSquare,
  RotateCw,
  Sparkles,
  SquareSlash,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fileSearchScore } from "../../shared/file-search-score.js";
import {
  EMPTY_PALETTE_SIGNALS,
  type PaletteSignals,
} from "../../shared/palette.js";
import type { WorkspaceTabRef } from "../../shared/workspace-tab-ref.js";
import {
  createPaletteIndex,
  frequentItems,
  type Rankable,
} from "../palette/rank.js";
import { hostOf } from "../palette/urls.js";
import { useAgentCommands } from "./agent-commands.js";
import { appsQuery } from "./apps.js";
import { normalizeCommandQuery } from "./command-score.js";
import { type AgentInfo, desktopApi } from "./desktop-api.js";
import { sessionLabel } from "./session-label.js";
import {
  entryInvocation,
  type SkillEntry,
  skillEntries,
} from "./skill-entries.js";
import { skillsForAgent, useProjectSkillCatalog } from "./skills.js";
import { textPill } from "./text-pills.js";

/**
 * The rows of a composer's menus (ADR 0272). "/" lists the shared skills
 * the chat's agent may use, the agent's own commands (when "/" starts an
 * otherwise empty message) and the chat's commands; "@" lists what a
 * message can point at. Both rank with the palette's index and its use
 * signals, so a skill picked in either place leads in both.
 */
export type ComposerPick =
  /** The skill goes in the message as a pill. */
  | { kind: "skill"; entry: SkillEntry }
  /** A harness's own command, sent as written ("/compact"). */
  | { kind: "command"; entry: SkillEntry }
  /** One of the chat's commands: runs now, the word goes. */
  | { kind: "action"; run: () => void }
  /** A pill pointing at a file, folder, tab, chat, workflow or app. */
  | { kind: "mention"; attachment: AgentTextAttachment }
  /** Load the catalog again. */
  | { kind: "retry" };

export interface ComposerMenuRow extends Rankable {
  id: string;
  icon: LucideIcon;
  label: string;
  detail?: string;
  keywords: string[];
  /** A quiet heading above the first row of its group. */
  group?: string;
  /** Opens a picker of its own: drawn with a chevron. */
  opens?: boolean;
  /** Informational: shown, never picked. */
  disabled?: boolean;
  /** Listed only for a query (an archived chat). */
  searchOnly?: boolean;
  /** A catalog still loading: drawn as a still bar holding its line. */
  loading?: boolean;
  pick: ComposerPick;
}

/** One of the chat's own commands, as the dock offers it right now. */
export interface ChatCommand {
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  keywords?: string[];
  opens?: boolean;
  run: () => void;
}

/** "pr-review" → "Pr review": a command's name read as a label. */
export function humanizeName(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : name;
}

/** Ranking signals, fresh each time a menu opens. */
function usePaletteSignals(active: boolean, refresh: number): PaletteSignals {
  const [signals, setSignals] = useState(EMPTY_PALETTE_SIGNALS);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the reopen signal
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void desktopApi
      .paletteSignals()
      .then((next) => {
        if (!cancelled) setSignals(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, refresh]);
  return signals;
}

/** Alphabetical, the most used first under Recent while nothing is typed. */
function rankRows(
  rows: ComposerMenuRow[],
  query: string,
  context: { signals: PaletteSignals; projectId?: string },
): ComposerMenuRow[] {
  if (query.trim()) return createPaletteIndex(rows)(query, context);
  const sorted = [...rows].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  const recent = frequentItems(sorted, { ...context, limit: 4 });
  if (recent.length === 0) return sorted;
  const taken = new Set(recent.map((row) => row.id));
  return [
    ...recent.map((row) => ({ ...row, group: "Recent" })),
    ...sorted
      .filter((row) => !taken.has(row.id))
      .map((row) => ({ ...row, group: "All" })),
  ];
}

const descriptionWords = (text: string) => text.split(/\s+/).slice(0, 12);

/** The row's name or label holds what was typed ("rev" → "Code review"). */
export function namedBy(row: ComposerMenuRow, typed: string): boolean {
  const name = row.id.slice(row.id.indexOf(":") + 1);
  const needle = normalizeCommandQuery(typed).trim();
  return [row.label, name].some((text) =>
    normalizeCommandQuery(text).includes(needle),
  );
}

/** "/": skills, the agent's own commands and the chat's commands. */
export function useSlashRows({
  active,
  refresh,
  projectId,
  agent,
  sessionId,
  query,
  alone,
  leads,
  commands,
}: {
  active: boolean;
  /** Bumped on every opening and retry: skills are files that change. */
  refresh: number;
  projectId: string;
  agent: AgentInfo | undefined;
  sessionId: string | null;
  query: string;
  /** "/" starts a message holding nothing else: native commands apply. */
  alone: boolean;
  /**
   * "/" starts the message. Mid-message a word like "/tmp" is more often a
   * path than a command, so rows there match by name only: a description
   * that happens to match never takes the Enter that sends.
   */
  leads: boolean;
  commands: readonly ChatCommand[];
}): ComposerMenuRow[] {
  const catalog = useProjectSkillCatalog(projectId, active, refresh);
  const native = useAgentCommands({
    projectId,
    agentId: agent?.id,
    sessionId,
    active,
    refresh,
  });
  const signals = usePaletteSignals(active, refresh);
  const harnessLabel =
    agent?.harness === "codex" ? "Codex skill" : "Claude Code";
  const entries = useMemo(
    () =>
      skillEntries({
        skills: skillsForAgent(catalog.skills, agent?.skills),
        commands: native.commands,
        harnessLabel,
        status: false,
      }),
    [catalog.skills, agent?.skills, native.commands, harnessLabel],
  );
  const rows = useMemo(() => {
    const skills = entries.flatMap((entry): ComposerMenuRow[] => {
      const keywords = [
        entry.name,
        entry.source,
        ...descriptionWords(entry.description),
      ];
      if (entry.kind === "command")
        return alone
          ? [
              {
                id: `command:${entry.name}`,
                icon: SquareSlash,
                label: humanizeName(entry.name),
                detail: entry.description || `${entry.source} command`,
                keywords,
                category: "command",
                usage: `skill:${entry.name}`,
                pick: { kind: "command", entry },
              },
            ]
          : [];
      return [
        {
          id: `skill:${entry.name}`,
          icon: Sparkles,
          label: entry.skillPath ? humanizeName(entry.title) : entry.title,
          detail: entry.description || entry.source,
          keywords,
          category: "command",
          usage: `skill:${entry.name}`,
          pick: { kind: "skill", entry },
        },
      ];
    });
    const actions = commands.map(
      (command): ComposerMenuRow => ({
        id: `action:${command.id}`,
        icon: command.icon,
        label: command.label,
        detail: command.detail,
        keywords: [...(command.keywords ?? [])],
        category: "command",
        usage: `action:${command.id}`,
        ...(command.opens ? { opens: true } : {}),
        pick: { kind: "action", run: command.run },
      }),
    );
    return [...actions, ...skills];
  }, [entries, commands, alone]);
  return useMemo(() => {
    const typed = normalizeCommandQuery(query).trim();
    const ranked = rankRows(rows, query, { signals, projectId }).filter(
      (row) => leads || !typed || namedBy(row, typed),
    );
    const loading = catalog.loading || native.loading;
    const error = catalog.error ?? native.error;
    if (loading)
      return [
        ...ranked,
        {
          id: "skills:loading",
          icon: LoaderCircle,
          label: "Loading skills…",
          keywords: [],
          disabled: true,
          loading: true,
          pick: { kind: "retry" },
        },
      ];
    if (error)
      return [
        {
          id: "skills:error",
          icon: RotateCw,
          label: error,
          detail: "Press Enter to retry",
          keywords: [],
          pick: { kind: "retry" },
        },
        ...ranked,
      ];
    return ranked;
  }, [
    rows,
    query,
    leads,
    signals,
    projectId,
    catalog.loading,
    catalog.error,
    native.loading,
    native.error,
  ]);
}

const TAB_ICONS: Record<string, LucideIcon> = {
  browser: Globe,
  editor: FileCode,
  terminal: SquareTerminal,
  chat: MessageSquare,
  workflow: Workflow,
  app: LayoutGrid,
};

/** What a tab shows beside its title: where it points. */
function tabDetail(tab: WorkspaceTabRef): string {
  if (tab.url && /^https?:/i.test(tab.url)) return hostOf(tab.url);
  if (tab.filePath) return tab.filePath;
  return tab.kind === "chat" ? "Chat" : humanizeName(tab.kind);
}

/** A mentioned tab, as dragging it onto the chat pins it. */
function tabMention(tab: WorkspaceTabRef): AgentTextAttachment {
  const where = tab.url ?? tab.filePath;
  return textPill(
    where ? `${tab.title} — ${where}` : tab.title,
    {
      type: "tab",
      key: tab.key,
      kind: tab.kind,
      title: tab.title,
      ...(tab.url ? { url: tab.url } : {}),
      ...(tab.filePath ? { filePath: tab.filePath } : {}),
    },
    tab.title,
  );
}

/** A path's last part and the folder it is in ("src/lib/" → "lib", "src"). */
export function splitPath(path: string): { name: string; parent: string } {
  const trimmed = path.replace(/\/$/, "");
  const at = trimmed.lastIndexOf("/");
  return at === -1
    ? { name: trimmed, parent: "" }
    : { name: trimmed.slice(at + 1), parent: trimmed.slice(0, at) };
}

const GROUP_LIMITS = { tabs: 4, files: 20, chats: 5, workflows: 5, apps: 5 };

/** "@": open tabs, files and folders, chats, workflows and apps. */
export function useMentionRows({
  active,
  refresh,
  projectId,
  selfTabKey,
  selfSessionId,
  worktreePath,
  query,
}: {
  active: boolean;
  refresh: number;
  projectId: string;
  /** This chat's own tab and session: never mentioned in itself. */
  selfTabKey: string;
  selfSessionId: string | null;
  /** The chat's own checkout, when it is not the project folder. */
  worktreePath?: string;
  query: string;
}): ComposerMenuRow[] {
  const { apiClient } = useCatamorphic();
  const [tabs, setTabs] = useState<WorkspaceTabRef[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the reopen signal
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void desktopApi
      .workspaceTabs(projectId)
      .then((next) => {
        if (!cancelled) setTabs(next);
      })
      .catch(() => {
        if (!cancelled) setTabs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, projectId, refresh]);
  const [files, setFiles] = useState<{
    query: string;
    matches: { path: string; directory?: boolean }[];
  }>({ query: "", matches: [] });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void desktopApi
        .fileSearch({
          projectId,
          query,
          mode: "paths",
          ...(worktreePath ? { worktreePath } : {}),
        })
        .then((result) => {
          if (!cancelled) setFiles({ query, matches: result.matches });
        })
        .catch(() => {
          if (!cancelled) setFiles({ query, matches: [] });
        });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, projectId, query, worktreePath]);
  const sessions = useAgentSessions(active ? projectId : undefined, {
    limit: 100,
    refetchInterval: false,
  }).data?.items;
  const workflows = useWorkflows(active ? projectId : undefined).data;
  const apps = useQuery({
    ...appsQuery({ apiClient, projectId }),
    enabled: active,
    staleTime: 1000,
  }).data;
  const others = useMemo(() => {
    const tabRows = tabs
      .filter((tab) => tab.key !== selfTabKey)
      .map(
        (tab): ComposerMenuRow => ({
          id: `tab:${tab.key}`,
          icon: TAB_ICONS[tab.kind] ?? Globe,
          label: tab.title,
          detail: tabDetail(tab),
          keywords: [tab.kind, tab.url, tab.filePath].filter(
            (word): word is string => Boolean(word),
          ),
          category: "tab",
          group: "Open tabs",
          pick: { kind: "mention", attachment: tabMention(tab) },
        }),
      );
    const chatRows = (sessions ?? [])
      .filter((session) => session.id !== selfSessionId)
      .map((session): ComposerMenuRow => {
        const label = sessionLabel(session);
        const archived = session.visibility === "archived";
        return {
          id: `session:${session.id}`,
          icon: MessageSquare,
          label,
          detail: archived ? "Archived chat" : "Chat",
          keywords: ["chat", ...(archived ? ["archived"] : [])],
          category: "resource",
          group: "Chats",
          // Untyped, the list keeps to the chats the sidebar shows.
          searchOnly: session.visibility !== "promoted",
          pick: {
            kind: "mention",
            attachment: textPill(
              `Chat "${label}"`,
              { type: "url", url: `session:${session.id}` },
              label,
            ),
          },
        };
      });
    const workflowRows = (workflows ?? []).map((workflow): ComposerMenuRow => {
      const label = workflow.displayName ?? workflow.name;
      const url = `workflow:${workflow.name}`;
      return {
        id: url,
        icon: Workflow,
        label,
        detail: "Workflow",
        keywords: [workflow.name, "workflow"],
        category: "resource",
        group: "Workflows",
        pick: {
          kind: "mention",
          attachment: textPill(url, { type: "url", url }, label),
        },
      };
    });
    const appRows = (apps ?? []).map((app): ComposerMenuRow => {
      const url = `app:${app.name}`;
      return {
        id: url,
        icon: LayoutGrid,
        label: app.title,
        detail: "App",
        keywords: [app.name, "app"],
        category: "resource",
        group: "Apps",
        pick: {
          kind: "mention",
          attachment: textPill(url, { type: "url", url }, app.title),
        },
      };
    });
    return { tabRows, chatRows, workflowRows, appRows };
  }, [tabs, selfTabKey, sessions, selfSessionId, workflows, apps]);
  const index = useMemo(
    () =>
      createPaletteIndex([
        ...others.tabRows,
        ...others.chatRows,
        ...others.workflowRows,
        ...others.appRows,
      ]),
    [others],
  );
  return useMemo(() => {
    const fileRows = files.matches.map((match): ComposerMenuRow => {
      const { name, parent } = splitPath(match.path);
      return {
        id: `path:${match.path}`,
        icon: match.directory ? Folder : FileText,
        label: name,
        detail: parent,
        keywords: [match.path],
        category: "resource",
        group: "Files",
        pick: {
          kind: "mention",
          attachment: textPill(
            match.path,
            { type: "path", path: match.path },
            name,
          ),
        },
      };
    });
    const typed = query.trim();
    const matched = typed ? index(typed) : null;
    // Each group keeps the ranked order of its own matches, or its own
    // order (the chats most recent first) while nothing is typed.
    const pick = (rows: ComposerMenuRow[], limit: number) => {
      const group = new Set(rows);
      return (
        matched
          ? matched.filter((row) => group.has(row))
          : rows.filter((row) => !row.searchOnly)
      ).slice(0, limit);
    };
    return [
      ...pick(others.tabRows, typed ? GROUP_LIMITS.tabs : 6),
      // Files come ranked from main. The last answer stays while the next
      // loads, keeping only what still matches what is typed now.
      ...(files.query === query
        ? fileRows
        : fileRows.filter(
            (row) =>
              !typed || fileSearchScore(row.keywords[0] ?? "", typed) > 0,
          )
      ).slice(0, typed ? GROUP_LIMITS.files : 12),
      ...pick(others.chatRows, GROUP_LIMITS.chats),
      ...pick(others.workflowRows, GROUP_LIMITS.workflows),
      ...pick(others.appRows, GROUP_LIMITS.apps),
    ];
  }, [files, others, index, query]);
}

/** A skill as a pill: what the agent reads, where the person put it. */
export function skillMention(entry: SkillEntry): AgentTextAttachment {
  return textPill(
    entryInvocation(entry),
    {
      type: "skill",
      name: entry.name,
      ...(entry.skillPath ? { path: entry.skillPath } : {}),
    },
    entry.skillPath ? humanizeName(entry.title) : entry.title,
  );
}

/** One empty list, so a closed menu keeps its identity across renders. */
export const NO_MENU_ROWS: readonly ComposerMenuRow[] = [];

/** The row at `index` or the next one that can be picked; -1 when none can. */
export function firstPickable(
  rows: readonly ComposerMenuRow[],
  index: number,
): number {
  for (let at = Math.max(0, index); at < rows.length; at += 1)
    if (!rows[at]?.disabled) return at;
  for (let at = Math.max(0, index) - 1; at >= 0; at -= 1)
    if (!rows[at]?.disabled) return at;
  return -1;
}

/** The next pickable row `step` away, wrapping at either end. */
export function stepPickable(
  rows: readonly ComposerMenuRow[],
  from: number,
  step: 1 | -1,
): number {
  if (rows.length === 0) return -1;
  for (let moved = 1; moved <= rows.length; moved += 1) {
    const at =
      (((from + step * moved) % rows.length) + rows.length) % rows.length;
    if (!rows[at]?.disabled) return at;
  }
  return from;
}
