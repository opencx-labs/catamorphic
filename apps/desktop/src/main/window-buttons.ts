import type { BrowserWindow } from "electron";

type ButtonsWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "setWindowButtonVisibility"
>;

/**
 * The macOS close, minimize and full screen buttons of workspace windows.
 * They show while the window's profile allows them (`windowButtons`) and
 * its workspace has not hidden them itself: a collapsed sidebar holding the
 * header hides them until it is revealed. Other platforms draw a native
 * frame, which this leaves alone.
 */
export class WindowButtons<W extends ButtonsWindow> {
  /** Managed windows, and whether their workspace shows the buttons. */
  private readonly shown = new WeakMap<W, boolean>();

  constructor(
    private readonly options: {
      /** The window's profile preference, read when the buttons change. */
      allowed: (window: W) => boolean;
      platform?: NodeJS.Platform;
    },
  ) {}

  /** A workspace window, before its first show so hidden buttons never flash. */
  manage(window: W): void {
    this.shown.set(window, true);
    this.apply(window);
  }

  /** The workspace hides the buttons or shows them again. */
  request(window: W, shown: boolean): void {
    if (!this.shown.has(window)) return;
    this.shown.set(window, shown);
    this.apply(window);
  }

  /** Applies the current preference, after it or the window's profile changed. */
  apply(window: W): void {
    if ((this.options.platform ?? process.platform) !== "darwin") return;
    const shown = this.shown.get(window);
    if (shown === undefined || window.isDestroyed()) return;
    window.setWindowButtonVisibility(shown && this.options.allowed(window));
  }
}
