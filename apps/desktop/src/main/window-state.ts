import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import type { WorkspaceInitial } from "../shared/desktop-workspace.js";

/**
 * Normal window placement and its native presentation modes. The app's
 * window-state.json keeps one record per workspace window; project contents
 * remain in the existing per-project workspace store.
 */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1200,
  height: 800,
  maximized: false,
  fullscreen: false,
};

const SAVE_DEBOUNCE_MS = 300;

export function normalizeWindowState(raw: unknown): WindowState {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const width = num(record.width);
  const height = num(record.height);
  return {
    ...(num(record.x) !== undefined ? { x: num(record.x) } : {}),
    ...(num(record.y) !== undefined ? { y: num(record.y) } : {}),
    width: width && width > 0 ? width : DEFAULT_WINDOW_STATE.width,
    height: height && height > 0 ? height : DEFAULT_WINDOW_STATE.height,
    maximized: record.maximized === true,
    fullscreen: record.fullscreen === true,
  };
}

/**
 * Drop a saved position that no display can show anymore (at least a
 * usable corner of the window must land inside some display's work area);
 * a window with no position lets Electron center it.
 */
export function fitToDisplays(
  state: WindowState,
  displays: Array<{
    workArea: { x: number; y: number; width: number; height: number };
  }>,
): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const MIN_VISIBLE = 100;
  const visible = displays.some(({ workArea }) => {
    const overlapX =
      Math.min(state.x! + state.width, workArea.x + workArea.width) -
      Math.max(state.x!, workArea.x);
    const overlapY =
      Math.min(state.y! + state.height, workArea.y + workArea.height) -
      Math.max(state.y!, workArea.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
  if (visible) return state;
  const { x: _x, y: _y, ...rest } = state;
  return rest;
}

/** How far each new window steps from the one it opened from. */
export const CASCADE_STEP = 24;

/**
 * Where a window opened from another lands: as large as that window was
 * (never its maximized or full screen size), a step down and to the right,
 * as macOS cascades document windows. A step that would leave the display's
 * work area starts again from its top left corner.
 */
export function cascadeWindowState(
  from: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): WindowState {
  const width = Math.min(from.width, workArea.width);
  const height = Math.min(from.height, workArea.height);
  const x = from.x + CASCADE_STEP;
  const y = from.y + CASCADE_STEP;
  const fits =
    x + width <= workArea.x + workArea.width &&
    y + height <= workArea.y + workArea.height;
  return {
    x: fits ? x : workArea.x,
    y: fits ? y : workArea.y,
    width,
    height,
    maximized: false,
    fullscreen: false,
  };
}

export interface WorkspaceWindowState extends WorkspaceInitial {
  id: string;
  profileId: string;
  state: WindowState;
  visible: boolean;
  minimized: boolean;
}

export interface WindowSession {
  windows: WorkspaceWindowState[];
  lastFocusedWindowId?: string;
}

const savedWindowSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  projectIds: z.array(z.string().min(1)),
  activeProjectId: z.string().min(1).optional(),
  state: z.unknown().transform(normalizeWindowState),
  visible: z.boolean(),
  minimized: z.boolean(),
});

/** A partial/corrupt record cannot duplicate a window or a project's owner. */
export function normalizeWindowSession(raw: unknown): WindowSession {
  const result = z
    .object({
      windows: z.array(z.unknown()),
      lastFocusedWindowId: z.string().optional(),
    })
    .safeParse(raw);
  if (!result.success) return { windows: [] };
  const ids = new Set<string>();
  const projects = new Set<string>();
  const windows = result.data.windows.flatMap((item) => {
    const parsed = savedWindowSchema.safeParse(item);
    if (!parsed.success || ids.has(parsed.data.id)) return [];
    ids.add(parsed.data.id);
    const window = parsed.data;
    const projectIds = window.projectIds.filter((projectId) => {
      if (projects.has(projectId)) return false;
      projects.add(projectId);
      return true;
    });
    return [
      {
        ...window,
        projectIds,
        activeProjectId: projectIds.includes(window.activeProjectId ?? "")
          ? window.activeProjectId
          : projectIds[0],
      },
    ];
  });
  return {
    windows,
    lastFocusedWindowId: ids.has(result.data.lastFocusedWindowId ?? "")
      ? result.data.lastFocusedWindowId
      : undefined,
  };
}

type StateWindow = Pick<
  BrowserWindow,
  | "isDestroyed"
  | "getNormalBounds"
  | "isMaximized"
  | "isFullScreen"
  | "isVisible"
  | "isMinimized"
> & { on(event: string, listener: () => void): unknown };

/** One app-owned collection, so windows never overwrite one another. */
export class WindowStateStore<W extends StateWindow = BrowserWindow> {
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly tracked = new Map<
    string,
    {
      window: W;
      capture: () => WorkspaceWindowState;
    }
  >();
  private lastFocusedWindowId: string | undefined;
  private frozen = false;

  constructor(readonly file: string) {
    this.lastFocusedWindowId = this.load().lastFocusedWindowId;
  }

  load(): WindowSession {
    try {
      return normalizeWindowSession(
        JSON.parse(fs.readFileSync(this.file, "utf-8")),
      );
    } catch {
      return { windows: [] };
    }
  }

  /** A new window's default placement, never a second saved content payload. */
  placement(): WindowState {
    const session = this.tracked.size > 0 ? this.snapshot() : this.load();
    return (
      session.windows.find(
        (window) => window.id === session.lastFocusedWindowId,
      )?.state ??
      session.windows.at(-1)?.state ?? { ...DEFAULT_WINDOW_STATE }
    );
  }

  snapshot(): WindowSession {
    return {
      windows: [...this.tracked.values()]
        .filter(({ window }) => !window.isDestroyed())
        .map(({ capture }) => capture()),
      lastFocusedWindowId: this.lastFocusedWindowId,
    };
  }

  private save(): void {
    if (this.frozen) return;
    if (this.debounce) clearTimeout(this.debounce);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(
        temporary,
        `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      );
      fs.renameSync(temporary, this.file);
    } catch {
      // Best-effort: a failed save only costs the next launch's restoration.
    }
  }

  /** Metadata and geometry settle together in one collection write. */
  changed(): void {
    if (this.frozen) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  /** Quit/update teardown must not persist the shrinking set of windows. */
  freeze(): void {
    this.save();
    this.frozen = true;
  }

  /** A failed update or cancelled native close is live work again. */
  resume(): void {
    this.frozen = false;
    this.changed();
  }

  track({
    window,
    initial,
    workspace,
  }: {
    window: W;
    initial: WorkspaceWindowState;
    workspace: () => WorkspaceInitial & { profileId: string };
  }): void {
    const id = initial.id;
    let last = initial;
    // A restored hidden window keeps its modes until its first real show.
    let presented = window.isVisible();
    const capture = () => {
      last = {
        ...last,
        ...workspace(),
        state: {
          ...window.getNormalBounds(),
          maximized: presented ? window.isMaximized() : last.state.maximized,
          fullscreen: presented ? window.isFullScreen() : last.state.fullscreen,
        },
        visible: presented
          ? window.isVisible() || window.isMinimized()
          : last.visible,
        minimized: presented ? window.isMinimized() : last.minimized,
      };
      return last;
    };
    this.tracked.set(id, { window, capture });
    this.lastFocusedWindowId ??= id;
    for (const event of [
      "resize",
      "move",
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
      "hide",
      "minimize",
      "restore",
    ] as const)
      window.on(event, () => this.changed());
    window.on("show", () => {
      presented = true;
      this.changed();
    });
    window.on("focus", () => {
      this.lastFocusedWindowId = id;
      this.changed();
    });
    window.on("closed", () => {
      this.tracked.delete(id);
      if (this.lastFocusedWindowId === id)
        this.lastFocusedWindowId = [...this.tracked.keys()].at(-1);
      this.save();
    });
    this.changed();
  }
}

export function freshWindowState({
  profileId,
  projectId,
  state,
}: {
  profileId: string;
  projectId?: string;
  state: WindowState;
}): WorkspaceWindowState {
  return {
    id: randomUUID(),
    profileId,
    projectIds: projectId ? [projectId] : [],
    activeProjectId: projectId,
    state,
    visible: true,
    minimized: false,
  };
}
