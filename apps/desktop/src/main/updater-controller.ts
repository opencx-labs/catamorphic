import type {
  DesktopUpdateChannel,
  DesktopUpdateState,
} from "../shared/update.js";

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
  allowDowngrade: boolean;
  channel: string | null;
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
  channel: DesktopUpdateChannel;
  supported: boolean;
  updater: UpdaterAdapter | null;
  broadcast: (state: DesktopUpdateState) => void;
  logger?: Pick<Console, "error" | "info" | "warn">;
  prepareInstall?: () => Promise<void>;
  canInstall?: () => Promise<boolean>;
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
  private preparing = false;
  private manualCheckId = 0;
  private checking: Promise<void> | null = null;
  private downloading: Promise<void> | null = null;
  private readonly logger: Pick<Console, "error" | "info" | "warn">;

  constructor(private readonly options: DesktopUpdaterControllerOptions) {
    this.logger = options.logger ?? console;
    this.state = {
      phase: "idle",
      currentVersion: options.currentVersion,
      channel: options.channel,
      manual: false,
    };
    const updater = options.updater;
    if (!options.supported || !updater) return;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    this.configureChannel(options.channel);
    updater.fullChangelog = false;
    updater.on("checking-for-update", () => {
      this.setState({
        phase: "checking",
        currentVersion: options.currentVersion,
        channel: this.state.channel,
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
        channel: this.state.channel,
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
    updater.on("error", (error) => {
      if (this.preparing) return;
      this.handleError(error);
    });
  }

  current(): DesktopUpdateState {
    return this.state;
  }

  setChannel(channel: DesktopUpdateChannel): boolean {
    if (
      this.checking ||
      this.state.phase === "downloading" ||
      this.state.phase === "downloaded" ||
      this.state.phase === "installing"
    ) {
      return false;
    }
    if (channel === this.state.channel) return true;
    this.configureChannel(channel);
    this.setState({
      phase: "idle",
      currentVersion: this.options.currentVersion,
      channel,
      manual: false,
    });
    return true;
  }

  async check(manual: boolean): Promise<void> {
    if (manual) this.manualCheckId += 1;
    if (!this.options.supported || !this.options.updater) {
      this.setState({
        phase: "unsupported",
        currentVersion: this.options.currentVersion,
        channel: this.state.channel,
        manual,
        message: "Updates are checked by installed macOS builds.",
      });
      return;
    }
    if (
      this.state.phase === "downloading" ||
      this.state.phase === "downloaded" ||
      this.state.phase === "installing" ||
      (!manual && this.state.phase === "available")
    ) {
      if (manual) this.setState({ ...this.state, manual: true });
      return;
    }
    if (this.checking) {
      if (manual) {
        this.setState({ ...this.state, manual: true });
      }
      return this.checking;
    }
    this.setState({
      phase: "checking",
      currentVersion: this.options.currentVersion,
      channel: this.state.channel,
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
    const downloaded = this.state;
    this.setState({
      ...downloaded,
      phase: "installing",
      manual: true,
      message: undefined,
    });
    try {
      if (this.options.canInstall && !(await this.options.canInstall()))
        throw new Error(
          "Finish active agents and terminals before restarting.",
        );
      // Never call MacUpdater.quitAndInstall until native preparation has
      // completed. Its preparation path registers an uncancellable late quit.
      this.preparing = true;
      try {
        await this.options.prepareInstall?.();
      } finally {
        this.preparing = false;
      }
      if (this.current().phase !== "installing") return;
      if (this.options.canInstall && !(await this.options.canInstall()))
        throw new Error(
          "Work started while the update was preparing. Finish it, then restart.",
        );
      this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      this.logger.error("[desktop] update preparation failed:", error);
      this.setState({
        ...downloaded,
        manual: true,
        message: messageFor(error),
      });
    }
  }

  private setReleaseState(
    phase: "available" | "downloaded",
    info: UpdateInfoLike,
  ): void {
    this.setState({
      phase,
      currentVersion: this.options.currentVersion,
      channel: this.state.channel,
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
            channel: this.state.channel,
            manual: false,
          },
    );
  }

  private setState(state: DesktopUpdateState): void {
    this.state = {
      ...state,
      ...(this.manualCheckId ? { manualCheckId: this.manualCheckId } : {}),
    };
    this.options.broadcast(this.state);
  }

  private configureChannel(channel: DesktopUpdateChannel): void {
    const updater = this.options.updater;
    if (!updater) return;
    updater.channel = channel === "stable" ? "latest" : "alpha";
    updater.allowPrerelease = channel === "preview";
    // Setting electron-updater's channel enables downgrades implicitly. A
    // channel switch waits for a newer matching build instead of replacing a
    // user's app with an older release.
    updater.allowDowngrade = false;
  }
}
