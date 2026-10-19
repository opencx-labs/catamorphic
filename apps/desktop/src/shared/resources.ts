/**
 * What Work runs, by who it runs for (ADR 0266): one sample of every process
 * under Work's main process, grouped by owner, as `work:resources` lists it.
 */

/** Who a process runs for. */
export type ResourceOwner =
  /** Work itself: its main process, graphics, utilities and windows. */
  | { kind: "work" }
  /** A chat in its project: its harness and what that harness started. */
  | { kind: "chat"; sessionId: string; projectId: string }
  /** A terminal's shell and what runs in it. */
  | { kind: "terminal"; terminalId: string; title: string }
  /** A page: a browser tab, or a page another surface shows. */
  | { kind: "page"; webContentsId: number; title: string; url: string }
  /** A sidebar module's Bun worker (ADR 0140). */
  | { kind: "module"; modulePath: string };

/** The owners the main process learns from what started a process. */
export type RegisteredOwner = Extract<
  ResourceOwner,
  { kind: "chat" } | { kind: "terminal" } | { kind: "module" }
>;

export interface ResourceProcess {
  pid: number;
  /** The process this one descends from within its owner, if any. */
  parentPid?: number;
  /** A short name: "Main process", "Graphics", "bun", "claude". */
  name: string;
  /** The command line, for its preview; Work's own say what they are. */
  command: string;
  /** Percent of one core since the previous sample. */
  cpu: number;
  /** Resident memory in bytes. */
  memory: number;
  /** Recent CPU, oldest first, percent of one core. */
  history: number[];
  /** Whether End may end it: never Work's own processes or windows. */
  endable: boolean;
}

export interface ResourceGroup {
  /** Stable across samples: "work", "chat:<id>", "terminal:<id>", ... */
  id: string;
  owner: ResourceOwner;
  /** Root processes first, each followed by its descendants. */
  processes: ResourceProcess[];
  cpu: number;
  memory: number;
  history: number[];
}

export interface ResourceSnapshot {
  /** When it was sampled (ms since the epoch). */
  at: number;
  /** Logical cores: CPU can read up to `cores * 100`. */
  cores: number;
  /** Physical memory in bytes. */
  totalMemory: number;
  /**
   * Whether processes Work started are listed, beyond Electron's own
   * (false on Windows for now).
   */
  children: boolean;
  groups: ResourceGroup[];
  cpu: number;
  memory: number;
  history: number[];
}

/** The id a group of an owner has in every sample. */
export function resourceGroupId(owner: ResourceOwner): string {
  switch (owner.kind) {
    case "work":
      return "work";
    case "chat":
      return `chat:${owner.sessionId}`;
    case "terminal":
      return `terminal:${owner.terminalId}`;
    case "page":
      return `page:${owner.webContentsId}`;
    case "module":
      return `module:${owner.modulePath}`;
  }
}

/** "410 MB", "1.2 GB": short enough to stay whole on a row. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** "0%", "4%", "112%": percent of one core, as Activity Monitor reads it. */
export function formatCpu(cpu: number): string {
  if (cpu > 0 && cpu < 1) return "<1%";
  return `${Math.round(cpu)}%`;
}
