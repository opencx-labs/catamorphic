import { BrowserWindow, type WebContents, webContents } from "electron";
import type { ExtensionTabsReport } from "../../shared/extensions.js";

/**
 * The browser as extensions see it (ADR 0203): windows, their tabs in the
 * order the person sees them, each window's active tab, and tab groups.
 * A workspace window reports its browser tabs; a tab is its webview
 * guest, and its id is the guest's webContents id (the id Electron's own
 * `scripting` and `tabs.sendMessage` use). Windows an extension opens
 * itself hold one tab each.
 */

export type TabStatus = "loading" | "complete";

export interface TabRecord {
  id: number;
  guest: WebContents;
  windowId: number;
  index: number;
  active: boolean;
  status: TabStatus;
  favIconUrl: string | null;
  groupId: number;
  openerTabId: number | null;
  lastAccessed: number;
}

export interface WindowRecord {
  id: number;
  profileId: string;
  type: "normal" | "popup";
  window: BrowserWindow;
  /** Set for windows an extension opened. */
  openedBy: string | null;
}

export interface GroupRecord {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}

export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export type TabEvent =
  | { kind: "created"; tabId: number }
  | { kind: "removed"; tabId: number; windowId: number; closing: boolean }
  | { kind: "activated"; tabId: number; windowId: number }
  | { kind: "moved"; tabId: number; windowId: number; from: number; to: number }
  | { kind: "updated"; tabId: number; change: Record<string, unknown> }
  | { kind: "window-created"; windowId: number }
  | { kind: "window-removed"; windowId: number }
  | { kind: "window-focus"; windowId: number }
  | { kind: "group-created"; groupId: number }
  | { kind: "group-updated"; groupId: number }
  | { kind: "group-removed"; group: GroupRecord };

interface WindowTabs {
  record: WindowRecord;
  guestIds: number[];
  active: number | null;
}

export class TabRegistry {
  private readonly windows = new Map<number, WindowTabs>();
  private readonly tabs = new Map<number, TabRecord>();
  private readonly groups = new Map<number, GroupRecord>();
  private readonly watched = new WeakSet<WebContents>();
  private readonly lastFocused = new Map<string, number>();
  private nextGroupId = 1;

  constructor(
    private readonly emit: (profileId: string, event: TabEvent) => void,
  ) {}

  private profileOfWindow(windowId: number): string | null {
    return this.windows.get(windowId)?.record.profileId ?? null;
  }

  /** A workspace window's browser tabs, as the window shows them. */
  report(
    window: BrowserWindow,
    profileId: string,
    report: ExtensionTabsReport,
  ): void {
    const windowId = window.id;
    let entry = this.windows.get(windowId);
    if (entry && entry.record.profileId !== profileId) {
      // A window that switched profiles closes its old profile's tabs.
      this.closeWindow(windowId);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        record: {
          id: windowId,
          profileId,
          type: "normal",
          window,
          openedBy: null,
        },
        guestIds: [],
        active: null,
      };
      this.windows.set(windowId, entry);
      window.once("closed", () => this.closeWindow(windowId));
      this.emit(profileId, { kind: "window-created", windowId });
    }
    const valid = report.guestIds.filter((id) => {
      const guest = webContents.fromId(id);
      return (
        guest !== undefined &&
        !guest.isDestroyed() &&
        guest.getType() === "webview" &&
        guest.hostWebContents === window.webContents
      );
    });
    this.apply(entry, valid, report.activeGuestId);
  }

  private apply(
    entry: WindowTabs,
    guestIds: number[],
    activeGuestId: number | null,
  ): void {
    const { profileId } = entry.record;
    const windowId = entry.record.id;
    const before = entry.guestIds;
    const kept = new Set(guestIds);
    for (const id of before)
      if (!kept.has(id)) this.removeTab(id, windowId, false);
    entry.guestIds = guestIds;
    const previousIndex = new Map(before.map((id, index) => [id, index]));
    guestIds.forEach((id, index) => {
      const existing = this.tabs.get(id);
      if (existing) {
        existing.index = index;
        const from = previousIndex.get(id);
        if (from !== undefined && from !== index)
          this.emit(profileId, {
            kind: "moved",
            tabId: id,
            windowId,
            from,
            to: index,
          });
        return;
      }
      const guest = webContents.fromId(id);
      if (!guest) return;
      this.tabs.set(id, {
        id,
        guest,
        windowId,
        index,
        active: false,
        status: guest.isLoading() ? "loading" : "complete",
        favIconUrl: null,
        groupId: -1,
        openerTabId: null,
        lastAccessed: Date.now(),
      });
      this.watch(guest);
      this.emit(profileId, { kind: "created", tabId: id });
      this.catchUp(profileId, guest);
    });
    const active =
      activeGuestId !== null && kept.has(activeGuestId)
        ? activeGuestId
        : entry.active !== null && kept.has(entry.active)
          ? entry.active
          : (guestIds[0] ?? null);
    for (const id of guestIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.active = id === active;
    }
    if (active !== entry.active) {
      entry.active = active;
      if (active !== null) {
        const tab = this.tabs.get(active);
        if (tab) tab.lastAccessed = Date.now();
        this.emit(profileId, { kind: "activated", tabId: active, windowId });
      }
    }
  }

  /**
   * A page its window has not reported yet: a content script can speak
   * before the window's report arrives. It joins the end of the window's
   * tabs until the report places it.
   */
  adopt(guest: WebContents, profileId: string): TabRecord | null {
    const known = this.tab(guest.id);
    if (known) return known;
    if (guest.isDestroyed() || guest.getType() !== "webview") return null;
    const host = guest.hostWebContents;
    const window = host ? BrowserWindow.fromWebContents(host) : null;
    const entry = window ? this.windows.get(window.id) : undefined;
    if (!entry || entry.record.profileId !== profileId) return null;
    this.apply(entry, [...entry.guestIds, guest.id], entry.active);
    return this.tab(guest.id);
  }

  /** A window an extension opened: one tab, its own contents. */
  addWindow(record: WindowRecord): void {
    const contents = record.window.webContents;
    const entry: WindowTabs = {
      record,
      guestIds: [contents.id],
      active: contents.id,
    };
    this.windows.set(record.id, entry);
    this.tabs.set(contents.id, {
      id: contents.id,
      guest: contents,
      windowId: record.id,
      index: 0,
      active: true,
      status: contents.isLoading() ? "loading" : "complete",
      favIconUrl: null,
      groupId: -1,
      openerTabId: null,
      lastAccessed: Date.now(),
    });
    this.watch(contents);
    this.catchUp(record.profileId, contents);
    record.window.once("closed", () => this.closeWindow(record.id));
    this.emit(record.profileId, {
      kind: "window-created",
      windowId: record.id,
    });
    this.emit(record.profileId, { kind: "created", tabId: contents.id });
  }

  private closeWindow(windowId: number): void {
    const entry = this.windows.get(windowId);
    if (!entry) return;
    for (const id of entry.guestIds) this.removeTab(id, windowId, true);
    this.windows.delete(windowId);
    for (const group of [...this.groups.values()])
      if (group.windowId === windowId) this.groups.delete(group.id);
    this.emit(entry.record.profileId, { kind: "window-removed", windowId });
  }

  private removeTab(id: number, windowId: number, closing: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.windowId !== windowId) return;
    this.tabs.delete(id);
    const profileId = this.profileOfWindow(windowId);
    if (profileId)
      this.emit(profileId, { kind: "removed", tabId: id, windowId, closing });
    if (tab.groupId !== -1) this.pruneGroup(tab.groupId);
  }

  /**
   * A tab reported after its page already navigated: the loads it missed
   * end with the update Chrome would have sent, so a listener waiting for
   * `status: "complete"` or the address still hears it.
   */
  private catchUp(profileId: string, guest: WebContents): void {
    const url = guest.getURL();
    if (!url) return;
    const tab = this.tabs.get(guest.id);
    if (!tab) return;
    this.emit(profileId, {
      kind: "updated",
      tabId: tab.id,
      change: { status: tab.status, url },
    });
  }

  private watch(guest: WebContents): void {
    if (this.watched.has(guest)) return;
    this.watched.add(guest);
    const update = (change: Record<string, unknown>) => {
      const tab = this.tabs.get(guest.id);
      if (!tab) return;
      const profileId = this.profileOfWindow(tab.windowId);
      if (profileId)
        this.emit(profileId, { kind: "updated", tabId: tab.id, change });
    };
    const status = (next: TabStatus) => {
      const tab = this.tabs.get(guest.id);
      if (!tab || tab.status === next) return;
      tab.status = next;
      update(
        next === "loading"
          ? { status: next, url: guest.getURL() }
          : { status: next },
      );
    };
    guest.on("did-start-loading", () => status("loading"));
    guest.on("did-stop-loading", () => status("complete"));
    guest.on("did-navigate", (_event, url) => update({ url }));
    guest.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) update({ url });
    });
    guest.on("page-title-updated", (_event, title) => update({ title }));
    guest.on("page-favicon-updated", (_event, favicons) => {
      const tab = this.tabs.get(guest.id);
      const favIconUrl = favicons[0] ?? null;
      if (!tab || tab.favIconUrl === favIconUrl) return;
      tab.favIconUrl = favIconUrl;
      update({ favIconUrl });
    });
    guest.on("audio-state-changed", (event) =>
      update({ audible: event.audible }),
    );
    guest.once("destroyed", () => {
      const tab = this.tabs.get(guest.id);
      if (!tab) return;
      const entry = this.windows.get(tab.windowId);
      if (entry) {
        entry.guestIds = entry.guestIds.filter((id) => id !== guest.id);
        if (entry.active === guest.id) entry.active = null;
      }
      this.removeTab(guest.id, tab.windowId, false);
    });
  }

  /** Tell extensions a tab's muted state changed (main changed it). */
  noteMuted(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const profileId = this.profileOfWindow(tab.windowId);
    if (profileId)
      this.emit(profileId, {
        kind: "updated",
        tabId,
        change: { mutedInfo: { muted: tab.guest.isAudioMuted() } },
      });
  }

  focus(window: BrowserWindow | null, profileId: string | null): void {
    if (!window || !profileId) return;
    if (!this.windows.has(window.id)) return;
    this.lastFocused.set(profileId, window.id);
    this.emit(profileId, { kind: "window-focus", windowId: window.id });
  }

  blurAll(profileId: string): void {
    this.emit(profileId, { kind: "window-focus", windowId: -1 });
  }

  tab(id: number): TabRecord | null {
    const tab = this.tabs.get(id);
    if (!tab || tab.guest.isDestroyed()) return null;
    return tab;
  }

  tabProfile(id: number): string | null {
    const tab = this.tab(id);
    return tab ? this.profileOfWindow(tab.windowId) : null;
  }

  tabsOf(profileId: string): TabRecord[] {
    const out: TabRecord[] = [];
    for (const entry of this.windows.values()) {
      if (entry.record.profileId !== profileId) continue;
      for (const id of entry.guestIds) {
        const tab = this.tab(id);
        if (tab) out.push(tab);
      }
    }
    return out;
  }

  window(id: number): WindowRecord | null {
    const entry = this.windows.get(id);
    if (!entry || entry.record.window.isDestroyed()) return null;
    return entry.record;
  }

  windowsOf(profileId: string): WindowRecord[] {
    return [...this.windows.values()]
      .filter(
        (entry) =>
          entry.record.profileId === profileId &&
          !entry.record.window.isDestroyed(),
      )
      .map((entry) => entry.record);
  }

  tabsInWindow(windowId: number): TabRecord[] {
    return (this.windows.get(windowId)?.guestIds ?? [])
      .map((id) => this.tab(id))
      .filter((tab): tab is TabRecord => tab !== null);
  }

  activeTab(windowId: number): TabRecord | null {
    const active = this.windows.get(windowId)?.active;
    return active ? this.tab(active) : null;
  }

  /** The window the person last used in a profile (Chrome's "current"). */
  lastFocusedWindow(profileId: string): WindowRecord | null {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      const record = this.window(focused.id);
      if (record?.profileId === profileId) return record;
    }
    const last = this.lastFocused.get(profileId);
    const record = last === undefined ? null : this.window(last);
    if (record) return record;
    return (
      this.windowsOf(profileId).find((entry) => entry.type === "normal") ?? null
    );
  }

  windowOfContents(contents: WebContents): WindowRecord | null {
    const tab = this.tab(contents.id);
    if (tab) return this.window(tab.windowId);
    const host =
      contents.getType() === "webview" ? contents.hostWebContents : contents;
    const window = host ? BrowserWindow.fromWebContents(host) : null;
    return window ? this.window(window.id) : null;
  }

  // ---- Tab groups --------------------------------------------------------------

  group(id: number): GroupRecord | null {
    return this.groups.get(id) ?? null;
  }

  groupsOf(profileId: string): GroupRecord[] {
    return [...this.groups.values()].filter(
      (group) => this.profileOfWindow(group.windowId) === profileId,
    );
  }

  /** Put tabs in a group (a new one unless `groupId`); returns the group. */
  groupTabs(tabIds: number[], groupId: number | null): GroupRecord {
    const first = this.tab(tabIds[0] ?? -1);
    if (!first) throw new Error("No tab with that id.");
    let group = groupId === null ? null : this.groups.get(groupId);
    if (groupId !== null && !group)
      throw new Error(`No group with id: ${groupId}.`);
    const profileId = this.profileOfWindow(first.windowId) ?? "";
    if (!group) {
      group = {
        id: this.nextGroupId++,
        windowId: first.windowId,
        title: "",
        color:
          GROUP_COLORS[(this.nextGroupId - 2) % GROUP_COLORS.length] ?? "grey",
        collapsed: false,
      };
      this.groups.set(group.id, group);
      this.emit(profileId, { kind: "group-created", groupId: group.id });
    }
    for (const id of tabIds) {
      const tab = this.tab(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      if (tab.windowId !== group.windowId)
        throw new Error("Tabs can only be grouped within one window.");
    }
    for (const id of tabIds) {
      const tab = this.tab(id);
      if (!tab || tab.groupId === group.id) continue;
      const previous = tab.groupId;
      tab.groupId = group.id;
      this.emit(profileId, {
        kind: "updated",
        tabId: id,
        change: { groupId: group.id },
      });
      if (previous !== -1) this.pruneGroup(previous);
    }
    return group;
  }

  ungroupTabs(tabIds: number[]): void {
    for (const id of tabIds) {
      const tab = this.tab(id);
      if (!tab || tab.groupId === -1) continue;
      const previous = tab.groupId;
      tab.groupId = -1;
      const profileId = this.profileOfWindow(tab.windowId);
      if (profileId)
        this.emit(profileId, {
          kind: "updated",
          tabId: id,
          change: { groupId: -1 },
        });
      this.pruneGroup(previous);
    }
  }

  updateGroup(
    id: number,
    change: Partial<Pick<GroupRecord, "title" | "color" | "collapsed">>,
  ): GroupRecord {
    const group = this.groups.get(id);
    if (!group) throw new Error(`No group with id: ${id}.`);
    Object.assign(group, change);
    const profileId = this.profileOfWindow(group.windowId);
    if (profileId) this.emit(profileId, { kind: "group-updated", groupId: id });
    return group;
  }

  private pruneGroup(groupId: number): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const used = [...this.tabs.values()].some((tab) => tab.groupId === groupId);
    if (used) return;
    this.groups.delete(groupId);
    const profileId = this.profileOfWindow(group.windowId);
    if (profileId) this.emit(profileId, { kind: "group-removed", group });
  }
}
