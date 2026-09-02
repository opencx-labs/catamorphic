export type DesktopUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
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
  version?: string;
  releaseName?: string;
  releaseUrl?: string;
  percent?: number;
  message?: string;
}
