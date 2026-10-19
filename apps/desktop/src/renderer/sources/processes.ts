import {
  type AgentSessionData,
  agentSessionQueryKey,
} from "@catamorphic/react";
import {
  formatBytes,
  formatCpu,
  type ResourceGroup,
  type ResourceProcess,
  type ResourceSnapshot,
} from "../../shared/resources.js";
import type { SidebarMenuEntry, SidebarTrend } from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  capabilitiesOf,
  invalidateBranches,
  type SectionSource,
} from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";

/** How often a shown section samples again. */
const POLL_MS = 2_000;
/** A reading this high (percent of one core) is worth a warning tone. */
const BUSY_CPU = 90;

const END: SidebarMenuEntry = {
  action: "end",
  label: "End process",
  icon: "X",
  danger: true,
};

/** The least a line's top stands for, in percent of one core. */
const TREND_FLOOR = 20;

/**
 * CPU history with its current reading. Each line spans its own recent
 * peak (at least a fifth of a core), so a quiet process still shows its
 * shape; the label says how much it is.
 */
function cpuTrend(history: readonly number[], cpu: number): SidebarTrend {
  const top = Math.max(TREND_FLOOR, ...history);
  return {
    values: history.map((value) => value / top),
    label: formatCpu(cpu),
    ...(cpu >= BUSY_CPU ? { tone: "warning" as const } : {}),
  };
}

/** The busiest processes the Total row opens to. */
const BUSIEST = 5;

/**
 * A process: End is its one button, so every process row ends at the same
 * place and its numbers line up. Work's own say why they stay.
 */
function processRow(
  parentId: string,
  proc: ResourceProcess,
  idPrefix = "pid",
): SidebarSourceItem {
  return {
    id: `${idPrefix}:${proc.pid}`,
    parentId,
    label: proc.name,
    description: formatBytes(proc.memory),
    trend: cpuTrend(proc.history, proc.cpu),
    actions: [
      proc.endable
        ? END
        : { ...END, disabledReason: "Work needs this to keep running" },
    ],
    menu: [],
    contextMenu: proc.endable ? [END] : [],
    preview: {
      title: proc.name,
      ...(proc.command && proc.command !== proc.name
        ? { description: proc.command.slice(0, 400) }
        : {}),
      metadata: [
        { label: "Process ID", value: String(proc.pid) },
        { label: "CPU", value: formatCpu(proc.cpu) },
        { label: "Memory", value: formatBytes(proc.memory) },
      ],
    },
    data: {
      pid: proc.pid,
      ...(proc.parentPid ? { parentPid: proc.parentPid } : {}),
      command: proc.command,
      cpu: proc.cpu,
      memory: proc.memory,
    },
  };
}

/**
 * `work:resources` (ADR 0263): what Work runs, by who it runs for. A Total
 * row, then Work itself, each chat, terminal, browser tab and sidebar
 * module with processes; their processes nest under them, with CPU drawn
 * as a sparkline and memory beside it. End stops a process Work started;
 * a tab or terminal closes as its tab does.
 */
export function resourcesSource(deps: WorkSourceDeps): SectionSource {
  /** Chat titles read once each; null while unknown. */
  const titles = new Map<string, string | null>();
  let latest: ResourceSnapshot | undefined;

  const chatTitle = (sessionId: string): string | undefined => {
    const tab = deps
      .host()
      .tabs.find(
        (entry) => entry.kind === "chat" && entry.sessionId === sessionId,
      );
    if (tab?.label) return tab.label;
    const cached = deps.queryClient.getQueryData<AgentSessionData>(
      agentSessionQueryKey(deps.projectId, sessionId),
    )?.state.session.title;
    if (cached) return cached;
    if (!titles.has(sessionId) && deps.projectId) {
      titles.set(sessionId, null);
      void deps.apiClient
        .GET("/api/projects/{projectId}/agent/sessions/{sessionId}", {
          params: { path: { projectId: deps.projectId, sessionId } },
          parseAs: "text",
        })
        .then((response) => {
          if (typeof response.data !== "string") return;
          const detail: {
            snapshot?: { session?: { title?: string | null } };
          } = JSON.parse(response.data);
          titles.set(sessionId, detail.snapshot?.session?.title ?? null);
        })
        .catch(() => {});
    }
    return titles.get(sessionId) ?? undefined;
  };

  const groupRow = (group: ResourceGroup): SidebarSourceItem => {
    const { owner } = group;
    const host = deps.host();
    const base = {
      id: group.id,
      // The chevron ends an owner's row, where End ends a process's; what
      // an owner can do is on right-click.
      menu: [],
      hasChildren: group.processes.length > 0,
      description: formatBytes(group.memory),
      trend: cpuTrend(group.history, group.cpu),
      data: {
        owner,
        cpu: group.cpu,
        memory: group.memory,
        processes: group.processes.length,
      },
    };
    const preview = (title: string, description?: string) => ({
      title,
      ...(description ? { description } : {}),
      metadata: [
        { label: "CPU", value: formatCpu(group.cpu) },
        { label: "Memory", value: formatBytes(group.memory) },
        { label: "Processes", value: String(group.processes.length) },
      ],
    });
    const endAll: SidebarMenuEntry[] = group.processes.some(
      (proc) => proc.endable,
    )
      ? [{ ...END, label: "End its processes" }]
      : [];
    switch (owner.kind) {
      case "work":
        return {
          ...base,
          label: "Work",
          icon: "AppWindow",
          contextMenu: [],
          preview: preview(
            "Work",
            "Work itself, and what it started for no one in particular.",
          ),
        };
      case "chat": {
        const label = chatTitle(owner.sessionId) ?? "Chat";
        return {
          ...base,
          label,
          url: `session:${owner.sessionId}`,
          contextMenu: endAll,
          preview: preview(label, "Its agent, and the commands it runs."),
        };
      }
      case "terminal": {
        const tab = host.resourceTab(owner);
        const label =
          host.tabs.find((entry) => `${entry.kind}:${entry.name}` === tab)
            ?.label ?? `Terminal (${owner.title})`;
        const close: SidebarMenuEntry[] = [
          { action: "close", label: "Close terminal", icon: "X", danger: true },
        ];
        return {
          ...base,
          label,
          icon: "SquareTerminal",
          ...(tab ? { url: tab } : {}),
          contextMenu: close,
          preview: preview(label),
        };
      }
      case "page": {
        const tab = host.resourceTab(owner);
        const label =
          host.tabs.find((entry) => `${entry.kind}:${entry.name}` === tab)
            ?.label ??
          (owner.title || owner.url || "Page");
        const close: SidebarMenuEntry[] = tab
          ? [{ action: "close", label: "Close tab", icon: "X", danger: true }]
          : [];
        return {
          ...base,
          label,
          icon: "Globe",
          ...(tab ? { url: tab } : {}),
          contextMenu: close,
          preview: preview(label, owner.url),
        };
      }
      case "module":
        return {
          ...base,
          label: owner.modulePath,
          icon: "FileCode2",
          contextMenu: endAll,
          preview: preview(owner.modulePath, "A sidebar section's source."),
        };
    }
  };

  const read = async (): Promise<ResourceSnapshot> => {
    latest = await desktopApi.resourcesRead();
    return latest;
  };
  /**
   * A branch reads the sample its owners' rows showed, so an owner and its
   * processes always add up; only a branch opened later samples again.
   */
  const sampled = async (): Promise<ResourceSnapshot> =>
    latest && Date.now() - latest.at < POLL_MS / 2 ? latest : read();

  const source: SectionSource = {
    title: "Resources",
    empty: "Nothing to show.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId }) => {
      const snapshot = parentId ? await sampled() : await read();
      if (parentId === "total")
        return {
          items: snapshot.groups
            .flatMap((group) => group.processes)
            .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory)
            .slice(0, BUSIEST)
            .map((proc) => processRow("total", proc, "top")),
        };
      if (parentId) {
        const group = snapshot.groups.find((entry) => entry.id === parentId);
        return {
          items:
            group?.processes.map((proc) => processRow(group.id, proc)) ?? [],
        };
      }
      const total: SidebarSourceItem = {
        id: "total",
        hasChildren: true,
        label: "Total",
        icon: "Activity",
        description: formatBytes(snapshot.memory),
        trend: cpuTrend(snapshot.history, snapshot.cpu),
        menu: [],
        preview: {
          title: "Everything Work runs",
          description: snapshot.children
            ? "CPU is a share of one core; memory is what stays resident."
            : "Only Work's own processes are listed on this system.",
          metadata: [
            { label: "CPU", value: formatCpu(snapshot.cpu) },
            { label: "Memory", value: formatBytes(snapshot.memory) },
            {
              label: "Of this computer",
              value: `${Math.round((snapshot.memory / snapshot.totalMemory) * 100)}% of memory`,
            },
            { label: "Cores", value: String(snapshot.cores) },
          ],
        },
        data: {
          cpu: snapshot.cpu,
          memory: snapshot.memory,
          cores: snapshot.cores,
        },
      };
      return { items: [total, ...snapshot.groups.map(groupRow)] };
    },
    subscribe: (publish, { branches }) => {
      // Every open branch reads again: an owner's processes move with it.
      const timer = setInterval(() => {
        if (!document.hidden)
          invalidateBranches(publish, branches(), { quiet: true });
      }, POLL_MS);
      return () => clearInterval(timer);
    },
    action: async ({ itemId, action }) => {
      const pid = itemId.match(/^(?:pid|top):(\d+)$/)?.[1];
      if (pid && action === "end") {
        await desktopApi.resourcesEnd(Number(pid));
        return undefined;
      }
      const group = (latest ?? (await read())).groups.find(
        (entry) => entry.id === itemId,
      );
      if (!group) throw new Error("It is no longer running.");
      const { owner } = group;
      if (
        action === "close" &&
        (owner.kind === "page" || owner.kind === "terminal")
      ) {
        const tab = deps.host().resourceTab(owner);
        if (tab) deps.host().closeTab(tab);
        else if (owner.kind === "terminal")
          await desktopApi.terminalKill(owner.terminalId);
        else throw new Error("This tab is in another window.");
        return undefined;
      }
      if (action === "end") {
        // Each root takes what it started with it.
        for (const proc of group.processes)
          if (proc.endable && proc.parentPid === undefined)
            await desktopApi.resourcesEnd(proc.pid);
        return undefined;
      }
      throw new Error("Resources does not support this action.");
    },
  };
  return source;
}
