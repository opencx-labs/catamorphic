import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  type WebContents,
} from "electron";
import type {
  ChatDraft,
  DockCommand,
  DockData,
  DockSnapshot,
  WorkspaceEvent,
} from "../shared/desktop-workspace.js";
import type { WindowProfileRegistry } from "./index.js";
import type { ProfileConfigManager } from "./profile-config.js";

/** One owner per project. Presentation can be hidden without disposing resources. */
export class DesktopWorkspaces {
  private readonly owners = new Map<string, WebContents>();
  private readonly chats = new Map<
    string,
    { owner: WebContents; data: DockData }
  >();
  private readonly activeProjects = new Map<number, string>();
  private readonly activeChats = new Map<string, string>();
  private readonly floating = new Map<string, BrowserWindow>();
  private readonly lastWindows = new Map<string, BrowserWindow>();
  private quitting = false;
  private readonly drafts = new Map<string, ChatDraft>();
  private readonly initialProjects = new Map<number, string>();

  constructor(
    private readonly options: {
      windows: WindowProfileRegistry;
      config: ProfileConfigManager;
      showWindows: boolean;
      profileForProject: (projectId: string) => string;
      createWindow: (
        profileId: string,
        dock?: boolean,
        projectId?: string,
      ) => BrowserWindow;
    },
  ) {
    app.on("before-quit", () => {
      this.quitting = true;
    });
    app.on("browser-window-focus", (_event, window) => {
      const profileId = options.windows.profileFor(window.webContents);
      if (this.floating.get(profileId) === window) return;
      this.lastWindows.delete(profileId);
      this.lastWindows.set(profileId, window);
      this.broadcast(profileId);
    });
    options.config.onPrefsChanged((profileId) => {
      this.syncFloating(profileId);
      this.broadcast(profileId);
    });
    ipcMain.handle("catamorphic:workspace-initial", (event) =>
      this.initialProjects.get(event.sender.id),
    );
    ipcMain.handle("catamorphic:dock-draft-get", (event, localId: string) => {
      const chat = this.chats.get(localId);
      return chat && this.sameProfile(event.sender, chat.owner)
        ? (this.drafts.get(localId) ?? null)
        : null;
    });
    ipcMain.handle(
      "catamorphic:dock-draft-set",
      (event, localId: string, draft: ChatDraft) => {
        const chat = this.chats.get(localId);
        if (!chat || !this.sameProfile(event.sender, chat.owner)) return;
        this.drafts.set(localId, draft);
        for (const window of options.windows.windowsFor(
          options.windows.profileFor(event.sender),
        )) {
          if (window.webContents !== event.sender)
            window.webContents.send("catamorphic:dock-draft", {
              localId,
              draft,
            });
        }
      },
    );
    ipcMain.handle(
      "catamorphic:workspace-claim",
      (event, projectId: string) => {
        if (
          options.profileForProject(projectId) !==
          options.windows.profileFor(event.sender)
        )
          return false;
        const owner = this.owner(projectId);
        if (owner && owner !== event.sender) return false;
        this.owners.set(projectId, event.sender);
        return true;
      },
    );
    ipcMain.handle(
      "catamorphic:workspace-navigate",
      (event, projectId: string, newWindow: boolean) => {
        this.navigate({ sender: event.sender, projectId, newWindow });
      },
    );
    ipcMain.handle(
      "catamorphic:workspace-active",
      (event, projectId: string) => {
        if (this.owner(projectId) !== event.sender) return;
        this.activeProjects.set(event.sender.id, projectId);
        this.broadcast(options.windows.profileFor(event.sender));
      },
    );
    ipcMain.handle("catamorphic:dock-publish", (event, data: DockData) => {
      if (
        options.profileForProject(data.projectId) !==
        options.windows.profileFor(event.sender)
      )
        return;
      if (!this.owner(data.projectId))
        this.owners.set(data.projectId, event.sender);
      if (this.owner(data.projectId) !== event.sender) return;
      const previous = this.chats.get(data.entry.localId);
      this.chats.set(data.entry.localId, { owner: event.sender, data });
      const profileId = options.windows.profileFor(event.sender);
      if (
        data.entry.mode === "partial" &&
        previous?.data.entry.mode !== "partial"
      )
        this.activeChats.set(profileId, data.entry.localId);
      if (
        data.entry.mode === "min" &&
        this.activeChats.get(profileId) === data.entry.localId
      )
        this.activeChats.delete(profileId);
      this.broadcast(profileId);
    });
    ipcMain.handle(
      "catamorphic:dock-remove",
      (event, projectId: string, localId: string) => {
        if (this.owner(projectId) !== event.sender) return;
        this.chats.delete(localId);
        this.drafts.delete(localId);
        const profileId = options.windows.profileFor(event.sender);
        if (this.activeChats.get(profileId) === localId)
          this.activeChats.delete(profileId);
        this.broadcast(profileId);
      },
    );
    ipcMain.handle("catamorphic:dock-snapshot", (event) =>
      this.snapshot(event.sender),
    );
    ipcMain.handle(
      "catamorphic:dock-command",
      (event, command: DockCommand) => {
        const chat = this.chats.get(command.localId);
        if (
          !chat ||
          chat.data.projectId !== command.projectId ||
          !this.sameProfile(event.sender, chat.owner)
        )
          return;
        const action = command.event;
        if (
          ["surface", "mcpApp", "link", "file", "focus", "unsplit"].includes(
            action.kind,
          ) ||
          (action.kind === "entry" && action.entry.mode === "tab")
        ) {
          this.navigate({
            sender: event.sender,
            projectId: command.projectId,
            newWindow: false,
          });
        }
        chat.owner.send("catamorphic:workspace-event", {
          kind: "chat",
          command,
        } satisfies WorkspaceEvent);
      },
    );
    ipcMain.handle("catamorphic:dock-activate", (event, localId?: string) => {
      const profileId = options.windows.profileFor(event.sender);
      const chat = localId ? this.chats.get(localId) : undefined;
      if (localId && (!chat || !this.sameProfile(event.sender, chat.owner)))
        return;
      const previousId = this.activeChats.get(profileId);
      const previous = previousId ? this.chats.get(previousId) : undefined;
      if (
        previous &&
        previousId !== localId &&
        previous.data.entry.mode === "partial"
      ) {
        const command: DockCommand = {
          projectId: previous.data.projectId,
          localId: previous.data.entry.localId,
          event: {
            kind: "entry",
            entry: { ...previous.data.entry, mode: "min" },
          },
        };
        previous.owner.send("catamorphic:workspace-event", {
          kind: "chat",
          command,
        } satisfies WorkspaceEvent);
      }
      if (localId) this.activeChats.set(profileId, localId);
      else this.activeChats.delete(profileId);
      this.broadcast(profileId);
    });
    ipcMain.handle("catamorphic:dock-new-chat", (event) => {
      const snapshot = this.snapshot(event.sender);
      const owner = snapshot.activeProjectId
        ? this.owner(snapshot.activeProjectId)
        : undefined;
      if (owner && snapshot.activeProjectId)
        owner.send("catamorphic:workspace-event", {
          kind: "newChat",
          projectId: snapshot.activeProjectId,
        } satisfies WorkspaceEvent);
    });
    ipcMain.handle(
      "catamorphic:dock-action",
      (
        event,
        localId: string,
        action: "close" | "minimize" | "send",
        message?: string,
      ) => {
        const chat = this.chats.get(localId);
        if (!chat || !this.sameProfile(event.sender, chat.owner)) return;
        const profileId = options.windows.profileFor(event.sender);
        const floating = this.floating.get(profileId);
        const target =
          floating &&
          options.config.forProfile(profileId).prefs.load().dockDetached
            ? floating.webContents
            : event.sender;
        target.send("catamorphic:workspace-event", {
          kind: "dockAction",
          localId,
          action,
          message,
        } satisfies WorkspaceEvent);
      },
    );
    ipcMain.handle(
      "catamorphic:dock-resize",
      (event, size: { width: number; height: number }) => {
        const profileId = options.windows.profileFor(event.sender);
        const window = this.floating.get(profileId);
        if (
          !window ||
          window.webContents !== event.sender ||
          !Number.isFinite(size.height) ||
          !Number.isFinite(size.width)
        )
          return;
        const area = screen.getDisplayMatching(window.getBounds()).workArea;
        const bounds = window.getBounds();
        const nextHeight = Math.max(
          64,
          Math.min(Math.round(size.height), area.height),
        );
        const nextWidth = Math.max(
          100,
          Math.min(Math.round(size.width), area.width),
        );
        const side = options.config.forProfile(profileId).prefs.load().dockSide;
        window.setBounds({
          ...bounds,
          width: nextWidth,
          x: Math.max(
            area.x,
            Math.min(
              side === "right" ? bounds.x + bounds.width - nextWidth : bounds.x,
              area.x + area.width - nextWidth,
            ),
          ),
          height: nextHeight,
          y: Math.max(
            area.y,
            Math.min(
              bounds.y + bounds.height - nextHeight,
              area.y + area.height - nextHeight,
            ),
          ),
        });
      },
    );
  }

  /** Empty windows may change profiles; their previous claims cannot follow. */
  reassign(sender: WebContents, previousProfileId: string) {
    for (const [projectId, owner] of this.owners)
      if (owner === sender) this.owners.delete(projectId);
    this.activeProjects.delete(sender.id);
    this.initialProjects.delete(sender.id);
    if (this.lastWindows.get(previousProfileId)?.webContents === sender)
      this.lastWindows.delete(previousProfileId);
    const window = BrowserWindow.fromWebContents(sender);
    if (window) {
      const profileId = this.options.windows.profileFor(sender);
      this.lastWindows.set(profileId, window);
      this.syncFloating(profileId);
    }
    this.broadcast(previousProfileId);
    this.broadcast(this.options.windows.profileFor(sender));
  }

  isDock(window: BrowserWindow): boolean {
    return [...this.floating.values()].includes(window);
  }

  activateProfile(profileId: string): boolean {
    const window = this.lastWindows.get(profileId);
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    if (this.options.showWindows) {
      window.show();
      window.focus();
    }
    return true;
  }

  activate(): boolean {
    const window = [...this.lastWindows.values()]
      .reverse()
      .find((window) => !window.isDestroyed());
    if (!window) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }

  owner(projectId: string) {
    const owner = this.owners.get(projectId);
    return owner && !owner.isDestroyed() ? owner : undefined;
  }

  /** Agent workspace calls target this exact owner, including hidden projects. */
  target(projectId?: string): WebContents | undefined {
    if (projectId) return this.owner(projectId);
    const focused = BrowserWindow.getFocusedWindow();
    const profileId = focused
      ? this.options.windows.profileFor(focused.webContents)
      : [...this.lastWindows.keys()].at(-1);
    const dock = profileId ? this.floating.get(profileId) : undefined;
    if (
      dock &&
      profileId &&
      this.options.config.forProfile(profileId).prefs.load().dockDetached
    )
      return dock.webContents;
    return (profileId ? this.lastWindows.get(profileId) : undefined)
      ?.webContents;
  }

  track(window: BrowserWindow, dock = false) {
    const profileId = this.options.windows.profileFor(window.webContents);
    if (dock) return;
    this.lastWindows.set(profileId, window);
    window.on("closed", () => {
      for (const [projectId, owner] of this.owners)
        if (owner.isDestroyed()) this.owners.delete(projectId);
      for (const [localId, chat] of this.chats)
        if (chat.owner.isDestroyed()) {
          this.chats.delete(localId);
          this.drafts.delete(localId);
        }
      if (this.lastWindows.get(profileId) === window)
        this.lastWindows.delete(profileId);
      this.broadcast(profileId);
    });
    window.on("close", (event) => {
      if (this.quitting) return;
      // Explicit Quit owns teardown. Closing a workspace only hides its presentation.
      if ([...this.owners.values()].includes(window.webContents)) {
        event.preventDefault();
        window.hide();
      }
    });
    this.syncFloating(profileId);
  }

  private sameProfile(left: WebContents, right: WebContents) {
    return (
      this.options.windows.profileFor(left) ===
      this.options.windows.profileFor(right)
    );
  }

  private navigate(input: {
    sender: WebContents;
    projectId: string;
    newWindow: boolean;
  }) {
    const profileId = this.options.windows.profileFor(input.sender);
    if (this.options.profileForProject(input.projectId) !== profileId) return;
    const owner = this.owner(input.projectId);
    if (owner && !this.sameProfile(input.sender, owner)) return;
    const source =
      this.lastWindows.get(profileId) ??
      BrowserWindow.fromWebContents(input.sender);
    const target = owner
      ? BrowserWindow.fromWebContents(owner)
      : input.newWindow || !source
        ? this.options.createWindow(profileId, false, input.projectId)
        : source;
    if (!target) return;
    this.initialProjects.set(target.webContents.id, input.projectId);
    const send = () =>
      target.webContents.send("catamorphic:workspace-event", {
        kind: "navigate",
        projectId: input.projectId,
      } satisfies WorkspaceEvent);
    if (target.webContents.isLoading())
      target.webContents.once("did-finish-load", send);
    else send();
    if (target.isMinimized()) target.restore();
    if (this.options.showWindows) {
      target.show();
      target.focus();
    }
    this.lastWindows.set(profileId, target);
  }

  private snapshot(sender: WebContents): DockSnapshot {
    const profileId = this.options.windows.profileFor(sender);
    const prefs = this.options.config.forProfile(profileId).prefs.load();
    const currentWindow = this.lastWindows.get(profileId);
    return {
      chats: [...this.chats.values()]
        .filter(
          (chat) =>
            !chat.owner.isDestroyed() && this.sameProfile(sender, chat.owner),
        )
        .map((chat) => ({ ...chat.data, local: chat.owner === sender })),
      activeProjectId: this.activeProjects.get(
        currentWindow?.webContents.id ?? sender.id,
      ),
      activeChatId: this.activeChats.get(profileId),
      detached: prefs.dockDetached,
      multiProject: prefs.dockMultiProject,
      side: prefs.dockSide,
    };
  }

  private broadcast(profileId: string) {
    for (const window of this.options.windows.windowsFor(profileId))
      window.webContents.send(
        "catamorphic:dock-snapshot",
        this.snapshot(window.webContents),
      );
  }

  private syncFloating(profileId: string) {
    const prefs = this.options.config.forProfile(profileId).prefs.load();
    const existing = this.floating.get(profileId);
    if (!prefs.dockDetached) {
      existing?.hide();
      return;
    }
    if (existing && !existing.isDestroyed()) {
      const area = screen.getDisplayMatching(existing.getBounds()).workArea;
      const bounds = existing.getBounds();
      const x =
        prefs.dockSide === "left"
          ? area.x + 12
          : area.x + area.width - bounds.width - 12;
      if (Math.abs(bounds.x - x) > 1)
        existing.setPosition(
          x,
          Math.max(
            area.y,
            Math.min(bounds.y, area.y + area.height - bounds.height),
          ),
        );
      if (this.options.showWindows) existing.showInactive();
      return;
    }
    const window = this.options.createWindow(profileId, true);
    const area = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea;
    const width = Math.min(780, area.width - 24);
    window.setBounds({
      x:
        prefs.dockSide === "left"
          ? area.x + 12
          : area.x + area.width - width - 12,
      y: area.y + area.height - 88,
      width,
      height: 76,
    });
    this.floating.set(profileId, window);
    window.setAlwaysOnTop(true, "floating");
    if (process.platform !== "win32")
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.options.config
        .forProfile(profileId)
        .prefs.save({ dockDetached: false });
      window.hide();
    });
    window.on("moved", () => {
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const side =
        bounds.x + bounds.width / 2 < area.x + area.width / 2
          ? "left"
          : "right";
      const store = this.options.config.forProfile(profileId).prefs;
      if (store.load().dockSide !== side) store.save({ dockSide: side });
    });
  }
}
