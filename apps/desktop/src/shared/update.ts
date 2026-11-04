export type DesktopUpdatePhase =
  | "idle"
  | "unsupported"
  /** Running outside Applications (a disk image, Downloads): macOS cannot replace it. */
  | "move-required"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "up-to-date"
  | "error";

export type DesktopUpdateChannel = "stable" | "preview";

/** Renderer-safe projection of the main-process updater. */
export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  channel: DesktopUpdateChannel;
  /** Manual checks surface quiet results and errors; background checks do not. */
  manual: boolean;
  /** Identifies the latest explicit check so it can reopen a dismissed status. */
  manualCheckId?: number;
  /** Dismissal belongs to this message across all desktop windows. */
  dismissed?: boolean;
  version?: string;
  releaseName?: string;
  releaseUrl?: string;
  percent?: number;
  message?: string;
}

/** Progress alone does not create a new message; a new check or phase does. */
export function updateMessageKey(state: DesktopUpdateState): string {
  return `${state.channel}:${state.phase}:${state.version ?? state.currentVersion}:${state.manualCheckId ?? 0}`;
}
