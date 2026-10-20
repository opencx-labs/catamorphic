import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  screen,
  type WebContents,
} from "electron";
import { z } from "zod";
import type { ChatSessionAction } from "../shared/chat-session-actions.js";
import type {
  ChatDraft,
  DockAction,
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
  dockLanding,
  dockPosition,
  fitDockSize,
} from "../shared/dock-position.js";
import type { MenuItem } from "../shared/menu.js";
import { dockClicks } from "./dock-clicks.js";
import type { WindowProfileRegistry } from "./index.js";
import { popupNativeMenu } from "./native-menu.js";
import type { ProfileConfigManager } from "./profile-config.js";

const dockShapeSchema = z
  .array(
    z.object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  )
  .max(256)
  .nullable();

/** How long focus may be in no window while it passes between two. */
const FOCUS_SETTLE_MS = 150;

/**
 * How long a window may take to let a project go before that window comes
 * forward, so the request is seen to land; a later answer still moves it.
 */
const RELEASE_SLOW_MS = 3_000;
/** A window that never answers keeps the project. */
const RELEASE_ABANDON_MS = 30_000;
/** How long agent calls for a moving project wait for its new window. */
const ARRIVAL_TIMEOUT_MS = 15_000;
/** Chat verbs that show something in the chat's window, not in the dock. */
const WINDOW_VERBS: ReadonlySet<ChatSessionAction> = new Set([
  "rename",
  "new-subsession",
  "archive",
  "open-terminal",
  "open-preview",
]);

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
  private readonly workspaces = new WeakSet<BrowserWindow>();
  private readonly dockExpanded = new Map<string, boolean>();
  private readonly dockDrags = new Map<
    string,
    { x: number; left: number; side: "left" | "right" }
  >();
  private quitting = false;
  /**
   * Focus left the app, not just passed between its windows; so too at
   * launch, until a window first has it.
   */
  private focusLeftApp = true;
  // Detaching is a session choice; the `dockDetached` preference is only
  // the state a fresh launch starts in. Closing the detached window or
  // picking "Return dock to the window" never rewrites that default.
  private readonly detachOverrides = new Map<string, boolean>();
  // Chat regions reported by workspace windows (by webContents id). While
  // one of them is in front, the detached dock rests inside its region.
  private readonly dockRegions = new Map<number, DockRegion>();
  private readonly drafts = new Map<string, ChatDraft>();
  private readonly initialProjects = new Map<number, string>();
  /** Projects on their way to a window of their own, by project id. */
  private readonly releases = new Map<
    string,
    { owner: WebContents; settle: (released: boolean) => void }
  >();
  /**
   * What a moving project's workspace was as its old window let it go,
   * shells and unsent chats included, for its new window alone to open
   * once. Kept here, never on disk: a restart opens the saved workspace.
   */
  private readonly handoffs = new Map<string, unknown>();
  /** Moves under way, settled once the project shows somewhere again. */
  private readonly arrivals = new Map<
    string,
    { promise: Promise<void>; arrive: () => void }
  >();

  constructor(
    private readonly options: {
      windows: WindowProfileRegistry;
      config: ProfileConfigManager;
      profileForProject: (projectId: string) => string;
      createWindow: (
        profileId: string,
        dock?: boolean,
        projectId?: string,
        placement?: { cascadeFrom?: BrowserWindow },
      ) => BrowserWindow;
      /**
       * A project's old window let it go: its shells there wait for the
       * new window to take them over (terminal.ts handOff).
       */
      onReleased?: (projectId: string, from: WebContents) => void;
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
    // Focus passes between windows through none at all for a moment (on
    // X11, from the workspace to the dock): only focus still gone a moment
    // after a blur left the app, and any window taking it, the dock's own
    // included, means it did not.
    let leftApp: ReturnType<typeof setTimeout> | undefined;
    app.on("browser-window-focus", (_event, window) => {
      clearTimeout(leftApp);
      this.focusLeftApp = false;
      const profileId = options.windows.profileFor(window.webContents);
      if (this.floating.get(profileId) === window) return;
      this.lastWindows.delete(profileId);
      this.lastWindows.set(profileId, window);
      this.broadcast(profileId);
      // A workspace came to the front: the dock moves into its chat region.
      this.syncFloating(profileId);
    });
    app.on("browser-window-blur", () => {
      // When focus left the app, the dock returns to the display's work
      // area.
      clearTimeout(leftApp);
      leftApp = setTimeout(() => {
        if (this.quitting || BrowserWindow.getFocusedWindow()) return;
        this.focusLeftApp = true;
        for (const profileId of this.floating.keys())
          this.syncFloating(profileId);
      }, FOCUS_SETTLE_MS);
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
      (event, entries: readonly MenuItem[]) => {
        const profileId = options.windows.profileFor(event.sender);
        const window = this.floating.get(profileId);
        if (!window || window.webContents !== event.sender) return null;
        return popupNativeMenu(window, entries);
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
        // On its way to a window of its own, it is nobody else's meanwhile.
        if (this.releases.has(projectId)) return false;
        this.owners.set(projectId, event.sender);
        return true;
      },
    );
    ipcMain.handle(
      "catamorphic:workspace-handoff-put",
      (event, projectId: unknown, snapshot: unknown) => {
        if (typeof projectId !== "string") return;
        if (this.releases.get(projectId)?.owner !== event.sender) return;
        this.handoffs.set(projectId, snapshot);
      },
    );
    ipcMain.handle(
      "catamorphic:workspace-handoff-take",
      (event, projectId: unknown) => {
        if (typeof projectId !== "string") return null;
        if (this.owner(projectId) !== event.sender) return null;
        const snapshot = this.handoffs.get(projectId) ?? null;
        this.handoffs.delete(projectId);
        return snapshot;
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
      "catamorphic:workspace-release",
      (event, projectId: unknown, released: unknown) => {
        if (typeof projectId !== "string") return;
        const pending = this.releases.get(projectId);
        if (pending?.owner !== event.sender) return;
        pending.settle(released === true);
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
    // A window has opened a project's workspace (restored, a move's
    // hand-off taken): agent calls for it can go there now.
    ipcMain.handle(
      "catamorphic:workspace-ready",
      (event, projectId: unknown) => {
        if (typeof projectId !== "string") return;
        if (this.owner(projectId) !== event.sender) return;
        this.arrivals.get(projectId)?.arrive();
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
        // A chat leaving with its project for another window keeps what
        // was typed in it.
        if (!this.releases.has(projectId)) this.drafts.delete(localId);
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
          [
            "surface",
            "mcpApp",
            "link",
            "file",
            "focus",
            "unsplit",
            // The palette a composer's "/" opens is that window's.
            "openSkills",
          ].includes(action.kind) ||
          (action.kind === "entry" && action.entry.mode === "tab") ||
          // A verb that shows something in the chat's window (a rename or
          // subsession dialog, a terminal) brings that window forward.
          (action.kind === "menu" && WINDOW_VERBS.has(action.entry.action))
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
    ipcMain.handle("catamorphic:dock-new-chat", (event, input: unknown) => {
      const snapshot = this.snapshot(event.sender);
      const owner = snapshot.activeProjectId
        ? this.owner(snapshot.activeProjectId)
        : undefined;
      // Cmd+N in a workspace window is that window's Cmd+N: a New Tab in
      // front takes the chat. The dock's + and the detached dock keep it.
      const shortcut =
        z.object({ shortcut: z.literal(true) }).safeParse(input).success &&
        !snapshot.detached;
      if (owner && snapshot.activeProjectId)
        owner.send("catamorphic:workspace-event", {
          kind: "newChat",
          projectId: snapshot.activeProjectId,
          ...(shortcut ? { shortcut: true } : {}),
        } satisfies WorkspaceEvent);
    });
    ipcMain.handle(
      "catamorphic:dock-action",
      (event, localId: string, action: DockAction, message?: string) => {
        const chat = this.chats.get(localId);
        if (!chat || !this.sameProfile(event.sender, chat.owner)) return;
        const profileId = options.windows.profileFor(event.sender);
        const floating = this.floating.get(profileId);
        // The detached dock shows floating chats; a chat in a tab is shown
        // by its workspace window, which the action goes to instead.
        const inDock =
          floating &&
          this.detached(profileId) &&
          chat.data.entry.mode !== "tab";
        const target = inDock ? floating.webContents : event.sender;
        // Keys follow the chips the shortcut focuses, or the composer the
        // palette hands typing back to: the detached dock's window takes
        // the keyboard first.
        if (inDock && (action === "focusChips" || action === "resume"))
          floating.focus();
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
    // is over content; over empty space the window lets clicks through where
    // the platform keeps forwarding pointer moves to it (macOS, Windows).
    // Linux does not forward: an ignoring window loses the pointer at once,
    // its leave restores input, and the next move ignores again, dozens of
    // times a second while the pointer rests. There the window is shaped to
    // its content instead (dock-shape below; see dockClicks). Answers
    // whether clicks now pass through.
    ipcMain.handle(
      "catamorphic:dock-ignore-mouse",
      (event, ignore: boolean) => {
        const profileId = options.windows.profileFor(event.sender);
        const window = this.floating.get(profileId);
        if (!window || window.webContents !== event.sender) return false;
        const passThrough = ignore === true && dockClicks() === "pass-through";
        window.setIgnoreMouseEvents(passThrough, { forward: true });
        return passThrough;
      },
    );
    // Where clicks cannot pass through (Linux on X11), the window takes the
    // shape of what the dock draws, so its empty space is simply not the
    // dock's: clicks there reach whatever is behind, and nothing flickers.
    // Wayland has no window shapes in Electron, so there the dock keeps its
    // clicks. Answers whether the shape was applied. The renderer measures
    // in CSS pixels; the window is shaped in window pixels.
    ipcMain.handle("catamorphic:dock-shape", (event, raw: unknown) => {
      if (dockClicks() !== "shape") return false;
      const profileId = options.windows.profileFor(event.sender);
      const window = this.floating.get(profileId);
      if (!window || window.webContents !== event.sender) return false;
      const rects = dockShapeSchema.parse(raw);
      const zoom = window.webContents.getZoomFactor();
      const scaled = rects?.map((rect) => {
        const x = Math.floor(rect.x * zoom);
        const y = Math.floor(rect.y * zoom);
        return {
          x,
          y,
          width: Math.ceil((rect.x + rect.width) * zoom) - x,
          height: Math.ceil((rect.y + rect.height) * zoom) - y,
        };
      });
      // An empty list restores the whole window, so "nothing drawn" is one
      // transparent pixel in the corner.
      window.setShape(
        scaled === undefined
          ? []
          : scaled.length > 0
            ? scaled
            : [{ x: 0, y: 0, width: 1, height: 1 }],
      );
      return true;
    });
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
      const { width: nextWidth, height: nextHeight } = fitDockSize(size, area);
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
      const landing =
        input.size &&
        Number.isFinite(input.size.width) &&
        Number.isFinite(input.size.height)
          ? { ...fitDockSize(input.size, area), expanded: input.size.expanded }
          : null;
      if (landing) this.dockExpanded.set(profileId, landing.expanded === true);
      const { width, height } = landing ?? bounds;
      // Collapsed drags pick a corner; expanded drags pick where open chats
      // sit: left, center or right. The strip lands on the spot nearest its
      // centre, as in a workspace window (shared/dock-position.ts).
      const expanded = this.dockExpanded.get(profileId) === true;
      const current = prefs.load();
      // Where the strip is let go, not where the last move left it: a
      // coalesced final move must not skew the landing.
      const centre =
        Math.max(
          area.x,
          Math.min(
            area.x + area.width - bounds.width,
            drag.left + input.screenX - drag.x,
          ),
        ) +
        bounds.width / 2;
      const restsAt = (spot: "left" | "center" | "right") =>
        dockPosition({
          area,
          width: bounds.width,
          height: bounds.height,
          side: spot === "right" ? "right" : "left",
          centered: spot === "center",
        }).x +
        bounds.width / 2;
      const side =
        input.phase === "cancel"
          ? drag.side
          : (dockLanding({
              from: drag.side,
              centre,
              spots: [
                { spot: "left", at: restsAt("left") },
                { spot: "right", at: restsAt("right") },
              ],
            }) ?? drag.side);
      const placement =
        input.phase === "cancel"
          ? current.dockPlacement
          : (dockLanding({
              from: current.dockPlacement,
              centre,
              spots: [
                { spot: "left", at: restsAt("left") },
                { spot: "center", at: restsAt("center") },
                { spot: "right", at: restsAt("right") },
              ],
            }) ?? current.dockPlacement);
      const position = dockPosition({
        area,
        width,
        height,
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
        window.setBounds({ ...position, width, height }, !input.reducedMotion);
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

  /** A workspace window: not the dock, a sign-in popup or an extension's. */
  isWorkspace(window: BrowserWindow): boolean {
    return this.workspaces.has(window);
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
    this.workspaces.add(window);
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
    // Already moving: the request is under way.
    if (input.newWindow && this.releases.has(input.projectId)) return;
    // A window keeps every project it has shown alive behind the one in
    // front. Asked for a window of its own, such a project moves to one; a
    // project in front of a window (or about to be, in one still loading)
    // is already in one, which comes forward.
    if (
      owner &&
      input.newWindow &&
      (this.activeProjects.get(owner.id) ??
        this.initialProjects.get(owner.id)) !== input.projectId
    ) {
      void this.moveToNewWindow({ ...input, owner, profileId });
      return;
    }
    const target = owner
      ? BrowserWindow.fromWebContents(owner)
      : input.newWindow || !source
        ? this.newWindow(profileId, input.projectId, source)
        : source;
    if (!target) return;
    this.present(target, input);
  }

  /**
   * A new window for one project, owned by it from the start: the window
   * it came from, should it reach for the project in the meantime (its
   * chats needing attention), finds it taken. It opens a step down and to
   * the right of that window, as macOS cascades a new document window, so
   * it reads as another window rather than the same one changing.
   */
  private newWindow(
    profileId: string,
    projectId: string,
    from: BrowserWindow | null | undefined,
  ) {
    const window = this.options.createWindow(profileId, false, projectId, {
      cascadeFrom: from && !from.isDestroyed() ? from : undefined,
    });
    this.owners.set(projectId, window.webContents);
    return window;
  }

  /**
   * The owner lets the project go once nothing of it is mounted (its
   * workspace saved, its shells left running, its chats off the dock),
   * then the project opens in a window of its own, which takes them over.
   * A window that keeps it (showing it, or holding unsaved edits of it,
   * which it explains) or that does not answer comes forward instead.
   */
  private async moveToNewWindow(
    input: WorkspaceNavigation & {
      sender: WebContents;
      owner: WebContents;
      profileId: string;
    },
  ) {
    const { owner, projectId } = input;
    const keeper = () => {
      const window = BrowserWindow.fromWebContents(
        this.owner(projectId) ?? owner,
      );
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    };
    let arrive = () => {};
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ARRIVAL_TIMEOUT_MS);
      arrive = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const arrival = { promise, arrive };
    this.arrivals.set(projectId, arrival);
    void promise.then(() => {
      if (this.arrivals.get(projectId) === arrival)
        this.arrivals.delete(projectId);
    });
    const released = await new Promise<boolean>((resolve) => {
      // Slow to answer: the window comes forward so the request is seen to
      // land, and a later answer still moves the project.
      const slow = setTimeout(keeper, RELEASE_SLOW_MS);
      const abandon = setTimeout(() => settle(false), RELEASE_ABANDON_MS);
      const settle = (released: boolean) => {
        clearTimeout(slow);
        clearTimeout(abandon);
        if (this.releases.get(projectId)?.owner === owner)
          this.releases.delete(projectId);
        resolve(released);
      };
      const gone = () => settle(false);
      this.releases.set(projectId, {
        owner,
        settle: (released) => {
          owner.removeListener("destroyed", gone);
          settle(released);
        },
      });
      owner.once("destroyed", gone);
      owner.send("catamorphic:workspace-event", {
        kind: "release",
        projectId,
      } satisfies WorkspaceEvent);
    });
    if (owner.isDestroyed() || !released || this.owner(projectId) !== owner) {
      this.handoffs.delete(projectId);
      arrive();
      keeper();
      return;
    }
    // It opens beside the window it was asked from.
    const from =
      (!input.sender.isDestroyed() &&
        BrowserWindow.fromWebContents(input.sender)) ||
      BrowserWindow.fromWebContents(owner);
    this.owners.delete(projectId);
    this.options.onReleased?.(projectId, owner);
    // Its chats leave this window's dock; what was typed in them waits
    // for the new window (`drafts`, by chat).
    for (const [localId, chat] of this.chats)
      if (chat.owner === owner && chat.data.projectId === projectId)
        this.chats.delete(localId);
    this.broadcast(input.profileId);
    this.present(this.newWindow(input.profileId, projectId, from), input);
  }

  /**
   * Agent calls for a project wait while it moves to a window of its own,
   * until that window shows it: the old window has let it go and the new
   * one is still loading.
   */
  arrival(projectId: string | undefined): Promise<void> {
    return (
      (projectId && this.arrivals.get(projectId)?.promise) || Promise.resolve()
    );
  }

  /** Shows `projectId` in `target` and brings that window forward. */
  private present(target: BrowserWindow, input: WorkspaceNavigation) {
    const profileId = this.options.windows.profileFor(target.webContents);
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
      collapsed: prefs.dockCollapsed,
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
    // While focus is on the dock, or passing between windows, the dock
    // keeps to the workspace it last sat in.
    const anchor =
      focused === dock || (!focused && !this.focusLeftApp)
        ? this.lastWindows.get(profileId)
        : focused;
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

  /** The project a workspace window shows now, if it shows one. */
  activeProject(window: BrowserWindow): string | null {
    return this.activeProjects.get(window.webContents.id) ?? null;
  }

  /**
   * Where the person is (ADR 0265): the project in front of the profile's
   * workspace window they were last in, whichever window the dock floats
   * over or wherever its chat lives.
   */
  personProject(profileId: string): string | null {
    const window = this.lastWindows.get(profileId);
    if (!window || window.isDestroyed()) return null;
    return this.activeProject(window);
  }

  /** Whether a profile's dock floats detached now, as the person left it. */
  dockDetached(profileId: string): boolean {
    return this.detached(profileId);
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
    // Quitting closes the dock first: a workspace taking focus after that
    // would build a new one, which keeps the app from quitting.
    if (this.quitting) return;
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
    // Teardown closes the dock before the workspaces: a workspace taking
    // focus after that must not reach the destroyed window.
    window.on("closed", () => {
      if (this.floating.get(profileId) === window)
        this.floating.delete(profileId);
    });
  }
}
