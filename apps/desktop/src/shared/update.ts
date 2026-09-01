export type DesktopUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error";

/** Renderer-safe projection of the main-process updater. */
export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  /** Manual checks surface quiet results and errors; background checks do not. */
  manual: boolean;
  version?: string;
  releaseName?: string;
  releaseUrl?: string;
  percent?: number;
  message?: string;
}
