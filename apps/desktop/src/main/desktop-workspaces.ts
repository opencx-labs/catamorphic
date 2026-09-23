import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  type WebContents,
} from "electron";
import { z } from "zod";
import type {
  ChatDraft,
  DockCommand,
  DockData,
  DockSnapshot,
  WorkspaceEvent,
  WorkspaceNavigation,
} from "../shared/desktop-workspace.js";
import {
  type DockDrag,
  type DockRegion,
  type DockSize,
  dockPosition,
} from "../shared/dock-position.js";
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
  private readonly dockExpanded = new Map<string, boolean>();
  private readonly dockDrags = new Map<
    string,
    { x: number; left: number; side: "left" | "right" }
  >();
  private quitting = false;
  // Detaching is a session choice; the `dockDetached` preference is only
  // the state a fresh launch starts in. Closing the detached window or
  // picking "Return dock to the window" never rewrites that default.
  private readonly detachOverrides = new Map<string, boolean>();
  // Chat regions reported by workspace windows (by webContents id). While
  // one of them is in front, the detached dock rests inside its region.
  private readonly dockRegions = new Map<number, DockRegion>();
  private readonly drafts = new Map<string, ChatDraft>();
  private readonly initialProjects = new Map<number, string>();

  constructor(
    private readonly options: {
      windows: WindowProfileRegistry;
      config: ProfileConfigManager;
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
    // An update restart closes every window without a before-quit; the
    // hide-on-close below would cancel it and the app would sit on
    // "Preparing to restart" forever.
    autoUpdater.on("before-quit-for-update", () => {
      this.quitting = true;
    });
    app.on("browser-window-focus", (_event, window) => {
      const profileId = options.windows.profileFor(window.webContents);
      if (this.floating.get(profileId) === window) return;
      this.lastWindows.delete(profileId);
      this.lastWindows.set(profileId, window);
      this.broadcast(profileId);
      // A workspace came to the front: the dock moves into its chat region.
      this.syncFloating(profileId);
    });
    app.on("browser-window-blur", () => {
      // Focus settles a tick later; when it left the app, the dock returns
      // to the display's work area.
      setTimeout(() => {
        if (BrowserWindow.getFocusedWindow()) return;
        for (const profileId of this.floating.keys())
          this.syncFloating(profileId);
      }, 0);
    });
    options.config.onPrefsChanged((profileId, prefs) => {
      // A changed default wins over the session choice made before it.
      if (this.detachOverrides.get(profileId) === prefs.dockDetached)
        this.detachOverrides.delete(profileId);
      this.syncFloating(profileId);
      this.broadcast(profileId);
    });
    // The detached window is a strip 124px tall: an in-page menu would be
    // clamped inside it, so its context menus are native and resolve with
    // the picked action.
    ipcMain.handle(
      "catamorphic:dock-menu",
      (
        event,
        entries: Array<{ label: string; action: string; danger?: boolean }>,
      ) => {
        const profileId = options.windows.profileFor(event.sender);
        const window = this.floating.get(profileId);
        if (!window || window.webContents !== event.sender) return null;
        return new Promise<string | null>((resolve) => {
          let picked: string | null = null;
          Menu.buildFromTemplate(
            entries.map((entry) => ({
              label: entry.label,
              click: () => {
                picked = entry.action;
              },
            })),
          ).popup({
            // At the cursor: window-relative coordinates land off target on
            // the transparent strip, and a right-click puts the cursor here.
            window,
            // Closing fires before click on some platforms; settle after both.
            callback: () => setTimeout(() => resolve(picked), 0),
          });
        });
      },
    );
    ipcMain.handle(
      "catamorphic:dock-region",
      (event, region: DockRegion | null) => {
        if (
          region &&
          [region.left, region.top, region.width, region.height].some(
            (value) => !Number.isFinite(value),
          )
        )
          return;
        if (region) this.dockRegions.set(event.sender.id, region);
        else this.dockRegions.delete(event.sender.id);
        this.syncFloating(options.windows.profileFor(event.sender));
      },
    );
    ipcMain.handle("catamorphic:dock-detach", (event, detached: boolean) => {
      const profileId = options.windows.profileFor(event.sender);
      this.setDetached(profileId, detached === true);
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
    ipcMain.handle("catamorphic:workspace-navigate", (event, raw: unknown) => {
      const input = z
        .object({
          projectId: z.string(),
          newWindow: z.boolean().optional(),
          surface: z
            .object({
              url: z.string().max(8192),
              title: z.string().max(4096),
              mode: z.enum(["replace", "tab", "side", "floating"]),
              nonce: z.string().max(128),
              open: z.enum(["page", "browser"]).optional(),
            })
            .optional(),
        })
        .parse(raw);
      this.navigate({ ...input, sender: event.sender });
    });
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
          floating && this.detached(profileId)
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
    // The detached dock carries transparent headroom above its strip so
    // hints can open above bubbles. The renderer reports whether the pointer
    // is over content; over empty space the window lets clicks through.
    ipcMain.handle(
      "catamorphic:dock-ignore-mouse",
      (event, ignore: boolean) => {
        const profileId = options.windows.profileFor(event.sender);
        const window = this.floating.get(profileId);
        if (!window || window.webContents !== event.sender) return;
        window.setIgnoreMouseEvents(ignore === true, { forward: true });
      },
    );
    ipcMain.handle("catamorphic:dock-resize", (event, size: DockSize) => {
      const profileId = options.windows.profileFor(event.sender);
      const window = this.floating.get(profileId);
      if (
        !window ||
        window.webContents !== event.sender ||
        !Number.isFinite(size.height) ||
        !Number.isFinite(size.width)
      )
        return;
      const area = this.dockArea(profileId, window);
      const nextHeight = Math.max(
        64,
        Math.min(Math.round(size.height), area.height),
      );
      const nextWidth = Math.max(
        100,
        Math.min(Math.round(size.width), area.width),
      );
      this.dockExpanded.set(profileId, size.expanded === true);
      const prefs = options.config.forProfile(profileId).prefs.load();
      window.setBounds({
        width: nextWidth,
        height: nextHeight,
        ...dockPosition({
          area,
          width: nextWidth,
          height: nextHeight,
          side:
            size.expanded && prefs.dockPlacement !== "center"
              ? prefs.dockPlacement
              : prefs.dockSide,
          centered: prefs.dockPlacement === "center" && size.expanded,
        }),
      });
    });
    ipcMain.handle("catamorphic:dock-drag", (event, input: DockDrag) => {
      const profileId = options.windows.profileFor(event.sender);
      const window = this.floating.get(profileId);
      if (
        !window ||
        window.webContents !== event.sender ||
        !Number.isFinite(input.screenX)
      )
        return;
      const prefs = options.config.forProfile(profileId).prefs;
      const bounds = window.getBounds();
      if (input.phase === "start") {
        this.dockDrags.set(profileId, {
          x: input.screenX,
          left: bounds.x,
          side: prefs.load().dockSide,
        });
        return;
      }
      const drag = this.dockDrags.get(profileId);
      if (!drag) return;
      const area = this.dockArea(profileId, window);
      if (input.phase === "move") {
        window.setPosition(
          Math.round(
            Math.max(
              area.x,
              Math.min(
                area.x + area.width - bounds.width,
                drag.left + input.screenX - drag.x,
              ),
            ),
          ),
          bounds.y,
        );
        return;
      }
      if (input.phase !== "end" && input.phase !== "cancel") return;
      // Collapsed drags pick a corner; expanded drags pick where open chats
      // sit: left, center or right thirds of the display.
      const expanded = this.dockExpanded.get(profileId) === true;
      const current = prefs.load();
      const side =
        input.phase === "cancel"
          ? drag.side
          : input.screenX < area.x + area.width / 2
            ? "left"
            : "right";
      const placement =
        input.phase === "cancel"
          ? current.dockPlacement
          : input.screenX < area.x + area.width / 3
            ? "left"
            : input.screenX > area.x + (area.width * 2) / 3
              ? "right"
              : "center";
      const position = dockPosition({
        area,
        ...bounds,
        side: expanded && placement !== "center" ? placement : side,
        centered: expanded && placement === "center",
      });
      try {
        if (expanded) {
          if (current.dockPlacement !== placement)
            prefs.save({ dockPlacement: placement });
        } else if (current.dockSide !== side) prefs.save({ dockSide: side });
      } finally {
        this.dockDrags.delete(profileId);
        window.setPosition(position.x, position.y, !input.reducedMotion);
      }
    });
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
    window.show();
    window.focus();
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
    if (dock && profileId && this.detached(profileId)) return dock.webContents;
    return (profileId ? this.lastWindows.get(profileId) : undefined)
      ?.webContents;
  }

  track(window: BrowserWindow, dock = false) {
    const profileId = this.options.windows.profileFor(window.webContents);
    if (dock) return;
    this.lastWindows.set(profileId, window);
    const contentsId = window.webContents.id;
    window.on("closed", () => {
      this.dockRegions.delete(contentsId);
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

  private navigate(input: WorkspaceNavigation & { sender: WebContents }) {
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
        surface: input.surface,
      } satisfies WorkspaceEvent);
    if (target.webContents.isLoading())
      target.webContents.once("did-finish-load", send);
    else send();
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
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
      detached: this.detached(profileId),
      multiProject: prefs.dockMultiProject,
      side: prefs.dockSide,
      placement: prefs.dockPlacement,
    };
  }

  private broadcast(profileId: string) {
    for (const window of this.options.windows.windowsFor(profileId))
      window.webContents.send(
        "catamorphic:dock-snapshot",
        this.snapshot(window.webContents),
      );
  }

  /**
   * Where the dock rests: the front workspace window's chat region when
   * one of this profile's windows is in front, else the display's work
   * area. Focus on the dock itself (a click on a bubble, typing in the
   * chat) keeps the workspace it was resting in as the anchor; otherwise
   * every open or collapse would move the strip between the region's
   * edge and the display's.
   */
  private dockArea(profileId: string, dock: BrowserWindow) {
    const focused = BrowserWindow.getFocusedWindow();
    const anchor = focused === dock ? this.lastWindows.get(profileId) : focused;
    if (
      anchor &&
      anchor !== dock &&
      !anchor.isDestroyed() &&
      anchor.isVisible() &&
      !anchor.isMinimized()
    ) {
      const region = this.dockRegions.get(anchor.webContents.id);
      if (
        region &&
        this.options.windows.profileFor(anchor.webContents) === profileId
      ) {
        const content = anchor.getContentBounds();
        return {
          x: Math.round(content.x + region.left),
          y: Math.round(content.y + region.top),
          width: Math.round(region.width),
          height: Math.round(region.height),
        };
      }
    }
    return screen.getDisplayMatching(dock.getBounds()).workArea;
  }

  private detached(profileId: string): boolean {
    return (
      this.detachOverrides.get(profileId) ??
      this.options.config.forProfile(profileId).prefs.load().dockDetached
    );
  }

  private setDetached(profileId: string, detached: boolean) {
    const preferred = this.options.config
      .forProfile(profileId)
      .prefs.load().dockDetached;
    if (detached === preferred) this.detachOverrides.delete(profileId);
    else this.detachOverrides.set(profileId, detached);
    this.syncFloating(profileId);
    this.broadcast(profileId);
  }

  private syncFloating(profileId: string) {
    const prefs = this.options.config.forProfile(profileId).prefs.load();
    const existing = this.floating.get(profileId);
    if (!this.detached(profileId)) {
      existing?.hide();
      return;
    }
    if (existing && !existing.isDestroyed()) {
      const area = this.dockArea(profileId, existing);
      const bounds = existing.getBounds();
      const expanded = this.dockExpanded.get(profileId) === true;
      const position = dockPosition({
        area,
        ...bounds,
        side:
          expanded && prefs.dockPlacement !== "center"
            ? prefs.dockPlacement
            : prefs.dockSide,
        centered: expanded && prefs.dockPlacement === "center",
      });
      if (
        !this.dockDrags.has(profileId) &&
        (Math.abs(bounds.x - position.x) > 1 ||
          Math.abs(bounds.y - position.y) > 1)
      )
        existing.setPosition(position.x, position.y);
      existing.showInactive();
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
      y: area.y + area.height - 136,
      width,
      height: 124,
    });
    this.floating.set(profileId, window);
    window.setAlwaysOnTop(true, "floating");
    // The dock follows every Space. Not `visibleOnFullScreen`: Electron
    // implements that by turning the whole process into a UIElement app,
    // which drops Work from the Dock and the app switcher.
    if (process.platform !== "win32")
      window.setVisibleOnAllWorkspaces(true, {
        skipTransformProcessType: true,
      });
    window.on("close", (event) => {
      if (this.quitting) return;
      // Closing returns the dock to the window for this session only, so a
      // restart (or a killed dev instance) comes back with the chosen default.
      event.preventDefault();
      this.setDetached(profileId, false);
    });
  }
}
