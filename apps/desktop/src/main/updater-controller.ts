import type { DesktopUpdateState } from "../shared/update.js";

export interface UpdateInfoLike {
  version: string;
  releaseName?: string | null;
}

export interface ProgressInfoLike {
  percent: number;
}

export interface UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  fullChangelog: boolean;
  on(event: "checking-for-update", listener: () => void): this;
  on(event: "update-available", listener: (info: UpdateInfoLike) => void): this;
  on(
    event: "update-not-available",
    listener: (info: UpdateInfoLike) => void,
  ): this;
  on(
    event: "download-progress",
    listener: (info: ProgressInfoLike) => void,
  ): this;
  on(
    event: "update-downloaded",
    listener: (info: UpdateInfoLike) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface DesktopUpdaterControllerOptions {
  currentVersion: string;
  supported: boolean;
  updater: UpdaterAdapter | null;
  broadcast: (state: DesktopUpdateState) => void;
  beforeInstall: () => Promise<void>;
  logger?: Pick<Console, "error" | "info" | "warn">;
}

function releaseUrl(version: string): string {
  return `https://github.com/opencx-labs/catamorphic/releases/tag/desktop-v${version}`;
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The update service could not be reached.";
}

export class DesktopUpdaterController {
  private state: DesktopUpdateState;
  private checking: Promise<void> | null = null;
  private downloading: Promise<void> | null = null;
  private readonly logger: Pick<Console, "error" | "info" | "warn">;

  constructor(private readonly options: DesktopUpdaterControllerOptions) {
    this.logger = options.logger ?? console;
    this.state = {
      phase: "idle",
      currentVersion: options.currentVersion,
      manual: false,
    };
    const updater = options.updater;
    if (!options.supported || !updater) return;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = options.currentVersion.includes("-");
    updater.fullChangelog = false;
    updater.on("checking-for-update", () => {
      this.setState({
        phase: "checking",
        currentVersion: options.currentVersion,
        manual: this.state.manual,
      });
    });
    updater.on("update-available", (info) => {
      this.setReleaseState("available", info);
    });
    updater.on("update-not-available", () => {
      this.setState({
        phase: this.state.manual ? "up-to-date" : "idle",
        currentVersion: options.currentVersion,
        manual: this.state.manual,
      });
    });
    updater.on("download-progress", (info) => {
      this.setState({
        ...this.state,
        phase: "downloading",
        manual: true,
        percent: Math.max(0, Math.min(100, info.percent)),
      });
    });
    updater.on("update-downloaded", (info) => {
      this.setReleaseState("downloaded", info);
    });
    updater.on("error", (error) => this.handleError(error));
  }

  current(): DesktopUpdateState {
    return this.state;
  }

  async check(manual: boolean): Promise<void> {
    if (!this.options.supported || !this.options.updater) {
      this.setState({
        phase: "unsupported",
        currentVersion: this.options.currentVersion,
        manual,
        message: "Updates are checked by installed macOS builds.",
      });
      return;
    }
    if (
      !manual &&
      (this.state.phase === "available" ||
        this.state.phase === "downloading" ||
        this.state.phase === "downloaded")
    ) {
      return;
    }
    if (this.checking) {
      if (manual && !this.state.manual) {
        this.setState({ ...this.state, manual: true });
      }
      return this.checking;
    }
    this.setState({
      phase: "checking",
      currentVersion: this.options.currentVersion,
      manual,
    });
    this.checking = this.options.updater
      .checkForUpdates()
      .then(() => undefined)
      .catch((error) => this.handleError(error))
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  async download(): Promise<void> {
    if (!this.options.updater || this.state.phase !== "available") return;
    if (this.downloading) return this.downloading;
    this.setState({
      ...this.state,
      phase: "downloading",
      manual: true,
      percent: 0,
    });
    this.downloading = this.options.updater
      .downloadUpdate()
      .then(() => undefined)
      .catch((error) => this.handleError(error))
      .finally(() => {
        this.downloading = null;
      });
    return this.downloading;
  }

  async install(): Promise<void> {
    if (!this.options.updater || this.state.phase !== "downloaded") return;
    try {
      await this.options.beforeInstall();
      this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      this.handleError(error);
    }
  }

  private setReleaseState(
    phase: "available" | "downloaded",
    info: UpdateInfoLike,
  ): void {
    this.setState({
      phase,
      currentVersion: this.options.currentVersion,
      manual: true,
      version: info.version,
      ...(info.releaseName ? { releaseName: info.releaseName } : {}),
      releaseUrl: releaseUrl(info.version),
    });
  }

  private handleError(error: unknown): void {
    this.logger.error("[desktop] update failed:", error);
    const visible = this.state.manual || this.state.phase === "downloading";
    this.setState(
      visible
        ? {
            ...this.state,
            phase: "error",
            manual: true,
            message: messageFor(error),
          }
        : {
            phase: "idle",
            currentVersion: this.options.currentVersion,
            manual: false,
          },
    );
  }

  private setState(state: DesktopUpdateState): void {
    this.state = state;
    this.options.broadcast(state);
  }
}
