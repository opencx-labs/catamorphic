import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_ID_ENV,
  SESSION_ID_ENV,
} from "@catamorphic/agent-protocol/runner";
import { app, ipcMain, type WebContents, webContents } from "electron";
import {
  type RegisteredOwner,
  type ResourceGroup,
  type ResourceOwner,
  type ResourceProcess,
  type ResourceSnapshot,
  resourceGroupId,
} from "../shared/resources.js";
import { registeredProcessOwners } from "./process-owners.js";

/** The sampler's own `ps` and `getconf`, never listed as Work's. */
const samplerPids = new Set<number>();

/** `execFile`, remembering the child so the table leaves it out. */
function run(
  command: string,
  args: string[],
  options: { maxBuffer?: number } = {},
): Promise<{ stdout: string; pid?: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout) => {
      if (child.pid) samplerPids.delete(child.pid);
      if (error) reject(Object.assign(error, { stdout }));
      else resolve({ stdout, ...(child.pid ? { pid: child.pid } : {}) });
    });
    if (child.pid) samplerPids.add(child.pid);
  });
}

/** Samples a read may share: windows reading together cost one. */
const SHARE_MS = 1_000;
/** Samples of history a sparkline draws. */
const HISTORY = 30;
/** A pause longer than this starts history again: its line would lie. */
const HISTORY_GAP_MS = 10_000;
/** How long an ended process has to exit before SIGKILL. */
const END_GRACE_MS = 3_000;
/** Interpreters whose name says less than what they run. */
const RUNNERS = new Set([
  "node",
  "bun",
  "bunx",
  "deno",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "ruby",
  "sh",
  "bash",
  "zsh",
  "fish",
]);

/** One process from the operating system's table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Resident memory in bytes. */
  memory: number;
  /** CPU time used so far, in seconds. */
  cpuTime: number;
  /** The table's own CPU reading, for a process seen the first time. */
  cpu?: number;
  /** The executable's name. */
  comm: string;
}

/** The chat a process works for, from its environment. */
export interface ChatTag {
  sessionId: string;
  projectId: string;
}

/** What a newly seen process is: its command line and chat tag. */
export interface ProcessDetail {
  command: string;
  chat?: ChatTag;
}

/** One of Electron's processes (`app.getAppMetrics()`). */
export interface ElectronProcess {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  /** Percent of one core since the previous call. */
  cpu: number;
  /** Bytes. */
  memory: number;
}

/** A webcontents and the processes its frames render in. */
export interface PageProcesses {
  id: number;
  type: string;
  title: string;
  url: string;
  pids: number[];
}

export interface ResourceSources {
  mainPid: number;
  /** The process table; null where Work does not read one (Windows). */
  table: () => Promise<ProcessRow[] | null>;
  details: (pids: number[]) => Promise<Map<number, ProcessDetail>>;
  electron: () => ElectronProcess[];
  pages: () => PageProcesses[];
  owners: () => ReadonlyMap<number, RegisteredOwner>;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  now: () => number;
  cores: number;
  totalMemory: number;
}

/** `[[dd-]hh:]mm:ss[.cc]`, as `ps -o time` prints it, in seconds. */
export function parsePsTime(text: string): number {
  const [days, clock] = text.includes("-")
    ? [Number(text.split("-")[0]), text.slice(text.indexOf("-") + 1)]
    : [0, text];
  const parts = clock.split(":").map(Number).reverse();
  const seconds =
    (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
  return Number.isFinite(seconds) ? days * 86_400 + seconds : 0;
}

/** `ps -axww -o pid=,ppid=,rss=,time=,%cpu=,comm=` (macOS). */
export function parsePsTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      memory: Number(match[3]) * 1024,
      cpuTime: parsePsTime(match[4] ?? ""),
      cpu: Number(match[5]),
      comm: path.basename(match[6] ?? ""),
    });
  }
  return rows;
}

/** One `/proc/<pid>/stat` (Linux). */
export function parseProcStat(
  text: string,
  units: { ticks: number; pageSize: number },
): ProcessRow | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(text.slice(0, open).trim());
  // Fields from the state on: ppid is the 2nd, utime the 12th, stime the
  // 13th and rss the 22nd (proc(5) numbers them 4, 14, 15 and 24).
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rss = Number(fields[21]);
  if (!Number.isFinite(pid) || !Number.isFinite(utime)) return null;
  return {
    pid,
    ppid: Number(fields[1]),
    memory: rss * units.pageSize,
    cpuTime: (utime + stime) / units.ticks,
    comm: text.slice(open + 1, close),
  };
}

/** The chat a process's environment names, with its project (ADR 0266). */
export function chatTag(environment: string): ChatTag | undefined {
  const value = (name: string) =>
    environment.match(new RegExp(`(?:^|[\\s\\0])${name}=([\\w-]+)`))?.[1];
  const sessionId = value(SESSION_ID_ENV);
  const projectId = value(PROJECT_ID_ENV);
  return sessionId && projectId ? { sessionId, projectId } : undefined;
}

/**
 * A name worth reading: "claude", or for an interpreter what it runs
 * ("bun run dev", "node server.js").
 */
export function processName(comm: string, command: string): string {
  const base = path.basename(comm);
  if (!RUNNERS.has(base)) return base;
  const words = command
    .split(/\s+/)
    .slice(1)
    .filter((word) => word && !word.startsWith("-"))
    .slice(0, 2)
    .map((word) => (word.includes("/") ? path.basename(word) : word));
  return [base, ...words].join(" ");
}

/** What a webcontents is to the person, for its renderer's row. */
function rendererName(type: string, title: string): string {
  if (type === "window") return title ? `Window: ${title}` : "Window";
  if (type === "backgroundPage")
    return title ? `Extension: ${title}` : "Extension";
  return title || "Page";
}

function electronName(proc: ElectronProcess): string {
  if (proc.type === "Browser") return "Main process";
  if (proc.type === "GPU") return "Graphics";
  if (proc.type === "Utility")
    return proc.name || proc.serviceName || "Utility";
  if (proc.type === "Tab") return "Renderer";
  return proc.name || proc.type;
}

const push = (history: number[] | undefined, value: number): number[] =>
  [...(history ?? []), value].slice(-HISTORY);

/**
 * Samples what Work runs when a section asks (ADR 0266). Nothing runs
 * between reads: the list polls only while a section showing it is.
 */
export class ResourceMonitor {
  private latest?: ResourceSnapshot;
  private sampling?: Promise<ResourceSnapshot>;
  private previous = new Map<number, { cpuTime: number; at: number }>();
  private detailCache = new Map<number, ProcessDetail & { comm: string }>();
  private processHistory = new Map<number, number[]>();
  private groupHistory = new Map<string, number[]>();
  private totalHistory: number[] = [];
  private firstSeen = new Map<string, number>();
  private order = 0;
  /** Endable processes of the last sample, each with its descendants. */
  private endable = new Map<number, number[]>();

  constructor(private readonly sources: ResourceSources) {}

  read(): Promise<ResourceSnapshot> {
    const now = this.sources.now();
    if (this.latest && now - this.latest.at < SHARE_MS)
      return Promise.resolve(this.latest);
    this.sampling ??= this.sample().finally(() => {
      this.sampling = undefined;
    });
    return this.sampling;
  }

  /**
   * End `pid` and what it started: SIGTERM, then SIGKILL for what still
   * runs after a grace period. Only a process the last sample listed as
   * endable: never Work's own.
   */
  end(pid: number): void {
    const descendants = this.endable.get(pid);
    if (!descendants)
      throw new Error("Work can only end a process it started for you");
    const targets = [pid, ...descendants];
    for (const target of [...targets].reverse()) this.signal(target, "SIGTERM");
    setTimeout(() => {
      for (const target of targets) {
        if (this.alive(target)) this.signal(target, "SIGKILL");
      }
    }, END_GRACE_MS).unref?.();
  }

  private signal(pid: number, signal: NodeJS.Signals) {
    try {
      this.sources.kill(pid, signal);
    } catch {
      // Gone already.
    }
  }

  private alive(pid: number): boolean {
    try {
      this.sources.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async sample(): Promise<ResourceSnapshot> {
    const { sources } = this;
    const at = sources.now();
    if (this.latest && at - this.latest.at > HISTORY_GAP_MS) {
      this.processHistory.clear();
      this.groupHistory.clear();
      this.totalHistory = [];
    }
    const table = await sources.table().catch(() => null);
    const electron = sources.electron();
    const pages = sources.pages();
    const registered = sources.owners();
    const electronPids = new Map(electron.map((proc) => [proc.pid, proc]));

    // Work's descendants outside Electron's own, in tree order.
    const children = new Map<number, ProcessRow[]>();
    for (const row of table ?? []) {
      const list = children.get(row.ppid) ?? [];
      list.push(row);
      children.set(row.ppid, list);
    }
    const descendants: ProcessRow[] = [];
    const walk = (pid: number) => {
      for (const child of children.get(pid) ?? []) {
        if (child.pid === sources.mainPid) continue;
        descendants.push(child);
        walk(child.pid);
      }
    };
    if (table) walk(sources.mainPid);

    const fresh = descendants.filter(
      (row) =>
        !electronPids.has(row.pid) &&
        this.detailCache.get(row.pid)?.comm !== row.comm,
    );
    if (fresh.length) {
      const details = await sources
        .details(fresh.map((row) => row.pid))
        .catch(() => new Map<number, ProcessDetail>());
      for (const row of fresh) {
        const detail = details.get(row.pid);
        this.detailCache.set(row.pid, {
          command: detail?.command ?? row.comm,
          ...(detail?.chat ? { chat: detail.chat } : {}),
          comm: row.comm,
        });
      }
    }
    const seen = new Set(descendants.map((row) => row.pid));
    for (const pid of this.detailCache.keys())
      if (!seen.has(pid)) this.detailCache.delete(pid);

    const groups = new Map<string, ResourceGroup>();
    const groupOf = (owner: ResourceOwner): ResourceGroup => {
      const id = resourceGroupId(owner);
      let group = groups.get(id);
      if (!group) {
        group = { id, owner, processes: [], cpu: 0, memory: 0, history: [] };
        groups.set(id, group);
      }
      return group;
    };
    const work: ResourceOwner = { kind: "work" };
    groupOf(work);
    const present = new Set<number>();
    const add = (
      owner: ResourceOwner,
      proc: Omit<ResourceProcess, "history">,
    ) => {
      const history = push(this.processHistory.get(proc.pid), proc.cpu);
      this.processHistory.set(proc.pid, history);
      present.add(proc.pid);
      groupOf(owner).processes.push({ ...proc, history });
    };

    // Electron's processes: Work's own, or the page a renderer draws.
    const pageOwners = new Map<
      number,
      { owner: ResourceOwner; name: string }
    >();
    for (const page of pages) {
      const isPage = page.type === "webview" || page.type === "browserView";
      const owner: ResourceOwner = isPage
        ? {
            kind: "page",
            webContentsId: page.id,
            title: page.title,
            url: page.url,
          }
        : work;
      for (const pid of page.pids)
        if (!pageOwners.has(pid))
          pageOwners.set(pid, {
            owner,
            name: isPage ? "Renderer" : rendererName(page.type, page.title),
          });
    }
    for (const proc of electron) {
      const page = pageOwners.get(proc.pid);
      add(page?.owner ?? work, {
        pid: proc.pid,
        name: page?.name ?? electronName(proc),
        command: proc.serviceName || proc.name || proc.type,
        cpu: proc.cpu,
        memory: proc.memory,
        endable: false,
      });
    }

    // What Work started: credited to the nearest owned ancestor.
    const ownerOf = new Map<number, ResourceOwner>();
    const parentOf = new Map(descendants.map((row) => [row.pid, row.ppid]));
    const endable = new Map<number, number[]>();
    for (const row of descendants) {
      const detail = this.detailCache.get(row.pid);
      const parentOwner = ownerOf.get(row.ppid) ?? work;
      const owner: ResourceOwner =
        registered.get(row.pid) ??
        (detail?.chat ? { kind: "chat", ...detail.chat } : parentOwner);
      ownerOf.set(row.pid, owner);
      if (electronPids.has(row.pid)) continue;
      const previous = this.previous.get(row.pid);
      const elapsed = previous ? (at - previous.at) / 1000 : 0;
      const cpu =
        previous && elapsed > 0
          ? Math.max(0, ((row.cpuTime - previous.cpuTime) / elapsed) * 100)
          : (row.cpu ?? 0);
      const sameGroup =
        row.ppid !== sources.mainPid &&
        !electronPids.has(row.ppid) &&
        resourceGroupId(parentOwner) === resourceGroupId(owner);
      const command = detail?.command ?? row.comm;
      add(owner, {
        pid: row.pid,
        ...(sameGroup ? { parentPid: row.ppid } : {}),
        name: processName(row.comm, command),
        command,
        cpu,
        memory: row.memory,
        endable: true,
      });
      endable.set(row.pid, []);
      // Every endable ancestor ends this one with it.
      let ancestor = row.ppid;
      while (endable.has(ancestor)) {
        endable.get(ancestor)?.push(row.pid);
        ancestor = parentOf.get(ancestor) ?? 0;
      }
    }
    this.endable = endable;
    this.previous = new Map(
      descendants.map((row) => [row.pid, { cpuTime: row.cpuTime, at }]),
    );
    for (const pid of this.processHistory.keys())
      if (!present.has(pid)) this.processHistory.delete(pid);

    // Totals, history, and a stable order: Work, then owners as they came.
    let cpu = 0;
    let memory = 0;
    for (const group of groups.values()) {
      group.processes = treeOrder(group.processes);
      group.cpu = group.processes.reduce((sum, proc) => sum + proc.cpu, 0);
      group.memory = group.processes.reduce(
        (sum, proc) => sum + proc.memory,
        0,
      );
      group.history = push(this.groupHistory.get(group.id), group.cpu);
      this.groupHistory.set(group.id, group.history);
      if (!this.firstSeen.has(group.id))
        this.firstSeen.set(group.id, this.order++);
      cpu += group.cpu;
      memory += group.memory;
    }
    for (const id of this.groupHistory.keys())
      if (!groups.has(id)) {
        this.groupHistory.delete(id);
        this.firstSeen.delete(id);
      }
    this.totalHistory = push(this.totalHistory, cpu);
    const snapshot: ResourceSnapshot = {
      at,
      cores: sources.cores,
      totalMemory: sources.totalMemory,
      children: table !== null,
      groups: [...groups.values()].sort(
        (a, b) =>
          KIND_ORDER[a.owner.kind] - KIND_ORDER[b.owner.kind] ||
          (this.firstSeen.get(a.id) ?? 0) - (this.firstSeen.get(b.id) ?? 0),
      ),
      cpu,
      memory,
      history: this.totalHistory,
    };
    this.latest = snapshot;
    return snapshot;
  }
}

const KIND_ORDER: Record<ResourceOwner["kind"], number> = {
  work: 0,
  chat: 1,
  terminal: 2,
  page: 3,
  module: 4,
};

/** Roots in pid order, each followed by its descendants. */
function treeOrder(processes: ResourceProcess[]): ResourceProcess[] {
  const pids = new Set(processes.map((proc) => proc.pid));
  const byParent = new Map<number | undefined, ResourceProcess[]>();
  for (const proc of processes) {
    const parent =
      proc.parentPid !== undefined && pids.has(proc.parentPid)
        ? proc.parentPid
        : undefined;
    const list = byParent.get(parent) ?? [];
    list.push(proc);
    byParent.set(parent, list);
  }
  const ordered: ResourceProcess[] = [];
  const visit = (parent: number | undefined) => {
    for (const proc of (byParent.get(parent) ?? []).sort(
      (a, b) => a.pid - b.pid,
    )) {
      ordered.push(proc);
      visit(proc.pid);
    }
  };
  visit(undefined);
  return ordered;
}

let linuxUnits: Promise<{ ticks: number; pageSize: number }> | undefined;
const unitsOf = () =>
  (linuxUnits ??= Promise.all([
    run("getconf", ["CLK_TCK"]).then(({ stdout }) => Number(stdout) || 100),
    run("getconf", ["PAGESIZE"]).then(({ stdout }) => Number(stdout) || 4096),
  ]).then(
    ([ticks, pageSize]) => ({ ticks, pageSize }),
    () => ({ ticks: 100, pageSize: 4096 }),
  ));

async function readTable(): Promise<ProcessRow[] | null> {
  if (process.platform === "darwin") {
    const { stdout, pid } = await run(
      "ps",
      ["-axww", "-o", "pid=,ppid=,rss=,time=,%cpu=,comm="],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    // The table lists the ps that printed it, finished by now.
    return parsePsTable(stdout).filter(
      (row) => row.pid !== pid && !samplerPids.has(row.pid),
    );
  }
  if (process.platform === "linux") {
    const units = await unitsOf();
    const entries = await fs.readdir("/proc");
    const rows = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) =>
          fs.readFile(`/proc/${entry}/stat`, "utf8").then(
            (text) => parseProcStat(text, units),
            () => null,
          ),
        ),
    );
    return rows.filter(
      (row): row is ProcessRow => row !== null && !samplerPids.has(row.pid),
    );
  }
  return null;
}

async function readDetails(
  pids: number[],
): Promise<Map<number, ProcessDetail>> {
  const details = new Map<number, ProcessDetail>();
  if (process.platform === "darwin") {
    const list = pids.join(",");
    const [args, environments] = await Promise.all([
      run("ps", ["-ww", "-o", "pid=,args=", "-p", list]).then(
        (result) => result.stdout,
        // ps exits 1 when one of the pids has gone: what it printed stands.
        (error: { stdout?: string }) => error.stdout ?? "",
      ),
      run("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", list]).then(
        (result) => result.stdout,
        (error: { stdout?: string }) => error.stdout ?? "",
      ),
    ]);
    const lines = (stdout: string) =>
      new Map(
        stdout.split("\n").flatMap((line) => {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          return match ? [[Number(match[1]), match[2] ?? ""] as const] : [];
        }),
      );
    const commands = lines(args);
    const tags = lines(environments);
    for (const pid of pids) {
      const command = commands.get(pid);
      const chat = chatTag(tags.get(pid) ?? "");
      if (command !== undefined || chat)
        details.set(pid, {
          command: command ?? "",
          ...(chat ? { chat } : {}),
        });
    }
    return details;
  }
  await Promise.all(
    pids.map(async (pid) => {
      const [command, environment] = await Promise.all([
        fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
        fs.readFile(`/proc/${pid}/environ`, "utf8").catch(() => ""),
      ]);
      const chat = chatTag(environment);
      details.set(pid, {
        command: command.split("\0").filter(Boolean).join(" "),
        ...(chat ? { chat } : {}),
      });
    }),
  );
  return details;
}

function pagesOf(all: WebContents[]): PageProcesses[] {
  return all.flatMap((contents) => {
    if (contents.isDestroyed()) return [];
    const pids = new Set<number>();
    try {
      pids.add(contents.getOSProcessId());
      for (const frame of contents.mainFrame?.framesInSubtree ?? [])
        if (frame.osProcessId) pids.add(frame.osProcessId);
    } catch {
      // A page mid-navigation may have no frame to ask.
    }
    return [
      {
        id: contents.id,
        type: contents.getType(),
        title: contents.getTitle(),
        url: contents.getURL(),
        pids: [...pids].filter((pid) => pid > 0),
      },
    ];
  });
}

/** The monitor over this process, Electron and the operating system. */
export function createResourceMonitor(): ResourceMonitor {
  return new ResourceMonitor({
    mainPid: process.pid,
    table: readTable,
    details: readDetails,
    electron: () =>
      app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        ...(metric.name ? { name: metric.name } : {}),
        ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
        cpu: metric.cpu.percentCPUUsage,
        memory: metric.memory.workingSetSize * 1024,
      })),
    pages: () => pagesOf(webContents.getAllWebContents()),
    owners: registeredProcessOwners,
    kill: (pid, signal) => process.kill(pid, signal),
    now: Date.now,
    cores: os.cpus().length,
    totalMemory: os.totalmem(),
  });
}

/** `work:resources` reads and ends through these (ADR 0266). */
export function registerResourceSupport(
  monitor: ResourceMonitor = createResourceMonitor(),
): () => void {
  ipcMain.handle("catamorphic:resources-read", () => monitor.read());
  ipcMain.handle("catamorphic:resources-end", (_event, pid: unknown) => {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid))
      throw new Error("A process id is a whole number");
    monitor.end(pid);
  });
  return () => {
    ipcMain.removeHandler("catamorphic:resources-read");
    ipcMain.removeHandler("catamorphic:resources-end");
  };
}
