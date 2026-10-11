import path from "node:path";
import { BrowserWindow, type WebContents, WebContentsView } from "electron";

/** How long the sheet's exit takes before its view leaves the popup. */
const EXIT_MS = 250;

interface Sheet {
  view: WebContentsView;
  window: BrowserWindow;
  fit: () => void;
  leaving?: NodeJS.Timeout;
}

/**
 * The passkey sheet over a browsing window that is not a tab, such as a
 * tab's sign-in popup (ADR 0220). The popup is a window of its own above
 * the workspace window, so the workspace's sheet would sit behind it: the
 * popup gets a transparent view of its own, laid over its page, that loads
 * the sheet alone. The view is made on the
 * popup's first passkey request and loads while the vault opens; it is
 * kept while the popup lives, and over the page only while a request
 * waits there to be answered. The page takes focus back after.
 */
export class PopupPasskeySheets {
  private readonly sheets = new Map<number, Sheet>();

  constructor(
    private readonly options: {
      /** The sheet over `popup` reads its tab's profile (theme, vault). */
      attach: (sheet: WebContents, popup: WebContents) => void;
    },
  ) {}

  /** The sheet's contents for `popup`, made (and loading) on first use. */
  sheet(popup: WebContents): WebContents | null {
    const window = BrowserWindow.fromWebContents(popup);
    if (!window || window.isDestroyed()) return null;
    return (this.sheets.get(popup.id) ?? this.create(popup, window)).view
      .webContents;
  }

  /** The sheet comes over the popup's page, in front and focused. */
  show(popup: WebContents): void {
    if (popup.isDestroyed()) return;
    const sheet = this.sheets.get(popup.id);
    if (!sheet || sheet.window.isDestroyed()) return;
    clearTimeout(sheet.leaving);
    sheet.leaving = undefined;
    sheet.fit();
    sheet.window.contentView.addChildView(sheet.view);
    sheet.view.webContents.focus();
  }

  /** No request waits over `popup` any more: the sheet leaves its page. */
  hide(popup: WebContents): void {
    // A closed popup took its sheet with it.
    if (popup.isDestroyed()) return;
    const sheet = this.sheets.get(popup.id);
    if (!sheet || sheet.leaving) return;
    // The page takes focus back from its own sheet at once, so it can ask
    // again, and never from wherever the person went since.
    if (sheet.window.isFocused() && sheet.view.webContents.isFocused())
      popup.focus();
    sheet.leaving = setTimeout(() => {
      sheet.leaving = undefined;
      if (!sheet.window.isDestroyed())
        sheet.window.contentView.removeChildView(sheet.view);
    }, EXIT_MS);
  }

  private create(popup: WebContents, window: BrowserWindow): Sheet {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    view.setBackgroundColor("#00000000");
    this.options.attach(view.webContents, popup);
    // The sheet page has nowhere to go: it never navigates or opens.
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (process.env.ELECTRON_RENDERER_URL)
      void view.webContents.loadURL(
        `${process.env.ELECTRON_RENDERER_URL}/passkey-sheet.html`,
      );
    else
      void view.webContents.loadFile(
        path.join(import.meta.dirname, "../renderer/passkey-sheet.html"),
      );
    const fit = () => {
      if (window.isDestroyed()) return;
      const { width, height } = window.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    window.on("resize", fit);
    const id = popup.id;
    const sheet: Sheet = { view, window, fit };
    this.sheets.set(id, sheet);
    window.once("closed", () => {
      clearTimeout(sheet.leaving);
      this.sheets.delete(id);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    });
    return sheet;
  }
}
