import {
  app,
  type BrowserWindow,
  Notification,
  nativeImage,
  shell,
} from "electron";
import { parseColor } from "./actions.js";
import type { ExtensionContext } from "./events.js";
import { type ExtensionsHost, groupObject } from "./host.js";
import { extensionFile, fileDataUrl, pixelsDataUrl } from "./icons.js";
import type { LoadedExtension } from "./loaded.js";
import { bestIcon } from "./manifest.js";
import { GROUP_COLORS, type TabRecord } from "./tabs.js";
import {
  extensionTabUrl,
  matchesAny,
  matchesPattern,
  scriptableUrl,
} from "./url-policy.js";
import { frameById, frameIds } from "./web-navigation.js";

/**
 * The `chrome.*` methods Work answers for extensions (ADR 0203), keyed
 * "namespace.method". The caller is resolved by the host from the IPC
 * sender; each handler checks the permission its namespace needs and
 * validates its arguments, since extension code is not trusted with more
 * than its manifest grants.
 */

export interface Caller {
  ext: LoadedExtension;
  context: ExtensionContext;
  /** The tab whose page made the call, if it is a tab. */
  tabId: number | null;
  /** The window of the calling page; null for a service worker. */
  windowId: number | null;
  /**
   * The call comes from something the person just did: a click or key in
   * the page (its own user activation), or, for a worker, an event the
   * person caused (the action, a command, a menu item, a notification).
   */
  gesture: boolean;
}

export type ApiHandler = (caller: Caller, args: unknown[]) => unknown;

type Bag = Record<string, unknown>;

const bag = (value: unknown): Bag =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
const numberOr = (value: unknown, fallback: number | null): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Chrome's `*` glob for title queries. */
function globMatches(glob: string, value: string): boolean {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "i").test(value);
}

const COMMON_FONTS = [
  "Arial",
  "Avenir",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Helvetica Neue",
  "Inter",
  "Menlo",
  "Monaco",
  "Open Sans",
  "Roboto",
  "SF Mono",
  "SF Pro",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Ubuntu",
  "Verdana",
];

export function createApi(host: ExtensionsHost): Record<string, ApiHandler> {
  const api: Record<string, ApiHandler> = {};
  const define = (
    namespace: string,
    permission: ((extension: LoadedExtension) => boolean) | string | null,
    handlers: Record<string, ApiHandler>,
  ) => {
    for (const [name, handler] of Object.entries(handlers)) {
      api[`${namespace}.${name}`] = (caller, args) => {
        const allowed =
          permission === null
            ? true
            : typeof permission === "string"
              ? caller.ext.has(permission)
              : permission(caller.ext);
        if (!allowed)
          throw new Error(
            `chrome.${namespace}.${name} needs a permission this extension does not have.`,
          );
        return handler(caller, args);
      };
    }
  };
  const profile = (caller: Caller) => caller.ext.profileId;
  const tabFor = (caller: Caller, tabId: unknown): TabRecord => {
    if (tabId === undefined || tabId === null) {
      const tab = host.defaultTab(caller);
      if (!tab) throw new Error("No active tab.");
      return tab;
    }
    return host.tabOf(caller, tabId);
  };
  const tab = (caller: Caller, record: TabRecord) =>
    host.tabObject(caller.ext, record);

  // ---- tabs ----------------------------------------------------------------------------

  const queryTabs = (caller: Caller, info: Bag): TabRecord[] => {
    const currentWindow =
      caller.windowId ?? host.tabs.lastFocusedWindow(profile(caller))?.id ?? -1;
    const lastFocused = host.tabs.lastFocusedWindow(profile(caller))?.id ?? -1;
    const urls = strings(info.url);
    return host.tabs.tabsOf(profile(caller)).filter((record) => {
      const window = host.tabs.window(record.windowId);
      if (typeof info.active === "boolean" && record.active !== info.active)
        return false;
      if (
        typeof info.highlighted === "boolean" &&
        record.active !== info.highlighted
      )
        return false;
      if (info.currentWindow === true && record.windowId !== currentWindow)
        return false;
      if (info.currentWindow === false && record.windowId === currentWindow)
        return false;
      if (info.lastFocusedWindow === true && record.windowId !== lastFocused)
        return false;
      if (info.lastFocusedWindow === false && record.windowId === lastFocused)
        return false;
      if (typeof info.windowId === "number") {
        const wanted = info.windowId === -2 ? currentWindow : info.windowId;
        if (record.windowId !== wanted) return false;
      }
      if (
        typeof info.windowType === "string" &&
        window?.type !== info.windowType
      )
        return false;
      if (typeof info.status === "string" && record.status !== info.status)
        return false;
      if (typeof info.index === "number" && record.index !== info.index)
        return false;
      if (typeof info.groupId === "number" && record.groupId !== info.groupId)
        return false;
      if (
        typeof info.audible === "boolean" &&
        record.guest.isCurrentlyAudible() !== info.audible
      )
        return false;
      if (
        typeof info.muted === "boolean" &&
        record.guest.isAudioMuted() !== info.muted
      )
        return false;
      if (
        info.pinned === true ||
        info.discarded === true ||
        info.frozen === true
      )
        return false;
      if (info.autoDiscardable === false) return false;
      const url = record.guest.getURL();
      const visible = caller.ext.seesTab(record.id, url);
      if (
        urls.length > 0 &&
        (!visible || !urls.some((pattern) => matchesPattern(pattern, url)))
      )
        return false;
      if (
        typeof info.title === "string" &&
        (!visible || !globMatches(info.title, record.guest.getTitle()))
      )
        return false;
      return true;
    });
  };

  const navigable = (caller: Caller, raw: unknown): string => {
    const url = extensionTabUrl(
      typeof raw === "string" ? raw : undefined,
      caller.ext.id,
    );
    if (url === null) throw new Error(`Cannot navigate to ${String(raw)}.`);
    return url;
  };

  const windowFor = (caller: Caller): BrowserWindow | null => {
    const record =
      caller.windowId !== null ? host.tabs.window(caller.windowId) : null;
    return record?.type === "normal" ? record.window : null;
  };

  define("tabs", null, {
    get: (caller, [tabId]) => tab(caller, host.tabOf(caller, tabId)),
    getCurrent: (caller) => {
      const record = caller.tabId !== null ? host.tabs.tab(caller.tabId) : null;
      return record ? tab(caller, record) : undefined;
    },
    query: (caller, [info]) =>
      queryTabs(caller, bag(info)).map((record) => tab(caller, record)),
    getSelected: (caller, [windowId]) => {
      const window = host.resolveWindow(caller, windowId);
      const record = host.tabs.activeTab(window.id);
      return record ? tab(caller, record) : undefined;
    },
    getAllInWindow: (caller, [windowId]) =>
      host.tabs
        .tabsInWindow(host.resolveWindow(caller, windowId).id)
        .map((record) => tab(caller, record)),
    create: async (caller, [properties]) => {
      const props = bag(properties);
      const url = navigable(caller, props.url) || "about:blank";
      const target =
        props.windowId === undefined
          ? windowFor(caller)
          : host.resolveWindow(caller, props.windowId).window;
      const created = await host.openInTab(
        profile(caller),
        url,
        props.active !== false,
        target,
      );
      if (!created) throw new Error("The tab could not be opened.");
      if (typeof props.openerTabId === "number")
        created.openerTabId = props.openerTabId;
      return tab(caller, created);
    },
    duplicate: async (caller, [tabId]) => {
      const source = host.tabOf(caller, tabId);
      const created = await host.openInTab(
        profile(caller),
        source.guest.getURL(),
        true,
        host.tabs.window(source.windowId)?.window ?? null,
      );
      if (!created) throw new Error("The tab could not be duplicated.");
      return tab(caller, created);
    },
    update: async (caller, args) => {
      const [first, second] = args;
      const tabId = typeof first === "number" ? first : undefined;
      // The tab id is optional and may be passed as undefined (null here).
      const props = bag(
        typeof first === "number" || first === null ? second : first,
      );
      const record = tabFor(caller, tabId);
      if (props.url !== undefined) {
        const url = navigable(caller, props.url);
        if (url) void record.guest.loadURL(url).catch(() => {});
      }
      if (typeof props.muted === "boolean") {
        record.guest.setAudioMuted(props.muted);
        host.tabs.noteMuted(record.id);
      }
      if (typeof props.openerTabId === "number")
        record.openerTabId = props.openerTabId;
      if (props.active === true || props.highlighted === true) {
        const window = host.tabs.window(record.windowId);
        if (window?.type === "normal")
          await host.requestWindow(window.window, {
            kind: "select-tab",
            guestId: record.id,
          });
      }
      return tab(caller, record);
    },
    remove: async (caller, [tabIds]) => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const id of ids) {
        const record = host.tabOf(caller, id);
        const window = host.tabs.window(record.windowId);
        if (!window) continue;
        if (window.type === "popup") window.window.close();
        else
          await host.requestWindow(window.window, {
            kind: "close-tab",
            guestId: record.id,
          });
      }
    },
    reload: (caller, args) => {
      const [first, second] = args;
      const record = tabFor(
        caller,
        typeof first === "number" ? first : undefined,
      );
      const props = bag(
        typeof first === "number" || first === null ? second : first,
      );
      if (props.bypassCache === true) record.guest.reloadIgnoringCache();
      else record.guest.reload();
    },
    goBack: (caller, [tabId]) => {
      const record = tabFor(caller, tabId);
      if (!record.guest.navigationHistory.canGoBack())
        throw new Error("Cannot find a next page in history.");
      record.guest.navigationHistory.goBack();
    },
    goForward: (caller, [tabId]) => {
      const record = tabFor(caller, tabId);
      if (!record.guest.navigationHistory.canGoForward())
        throw new Error("Cannot find a next page in history.");
      record.guest.navigationHistory.goForward();
    },
    highlight: async (caller, [info]) => {
      const props = bag(info);
      const window = host.resolveWindow(caller, props.windowId);
      const indexes = Array.isArray(props.tabs) ? props.tabs : [props.tabs];
      const tabs = host.tabs.tabsInWindow(window.id);
      const first = tabs[Number(indexes[0])];
      if (!first) throw new Error("No tab at that index.");
      if (window.type === "normal")
        await host.requestWindow(window.window, {
          kind: "select-tab",
          guestId: first.id,
        });
      return host.windowObject(caller.ext, window, true);
    },
    // Work keeps the person's tab order; a move leaves tabs where they are.
    move: (caller, [tabIds]) => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      const moved = ids.map((id) => tab(caller, host.tabOf(caller, id)));
      return Array.isArray(tabIds) ? moved : moved[0];
    },
    discard: (caller, [tabId]) => tab(caller, tabFor(caller, tabId)),
    detectLanguage: async (caller, [tabId]) => {
      const record = tabFor(caller, tabId);
      if (!scriptableUrl(record.guest.getURL())) return "und";
      const lang = await record.guest
        .executeJavaScript("document.documentElement.lang || ''", false)
        .catch(() => "");
      return typeof lang === "string" && lang ? lang : "und";
    },
    captureVisibleTab: async (caller, [windowId, options]) => {
      const window = host.resolveWindow(caller, windowId);
      const record = host.tabs.activeTab(window.id);
      if (!record) throw new Error("No active tab.");
      const url = record.guest.getURL();
      if (
        !caller.ext.holdsOrigin("<all_urls>") &&
        !caller.ext.activeTabs.has(record.id)
      )
        throw new Error(
          "Either the '<all_urls>' or 'activeTab' permission is required.",
        );
      if (!scriptableUrl(url))
        throw new Error(`Cannot access contents of url "${url}".`);
      const image = await record.guest.capturePage(undefined, {
        stayHidden: true,
      });
      const props = bag(options);
      if (props.format === "png") return image.toDataURL();
      const quality = Math.max(
        0,
        Math.min(100, numberOr(props.quality, 92) ?? 92),
      );
      return `data:image/jpeg;base64,${image.toJPEG(quality).toString("base64")}`;
    },
    group: (caller, [options]) => {
      const props = bag(options);
      const ids = (
        Array.isArray(props.tabIds) ? props.tabIds : [props.tabIds]
      ).map((id) => host.tabOf(caller, id).id);
      const group = host.tabs.groupTabs(
        ids,
        typeof props.groupId === "number" ? props.groupId : null,
      );
      return group.id;
    },
    ungroup: (caller, [tabIds]) => {
      const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(
        (id) => host.tabOf(caller, id).id,
      );
      host.tabs.ungroupTabs(ids);
    },
  });

  // ---- windows ------------------------------------------------------------------------------

  const windowTypes = (options: Bag) => {
    const types = strings(options.windowTypes);
    return types.length > 0 ? types : ["normal", "popup"];
  };
  define("windows", null, {
    get: (caller, [windowId, options]) => {
      const record = host.resolveWindow(caller, windowId);
      return host.windowObject(
        caller.ext,
        record,
        bag(options).populate === true,
      );
    },
    getCurrent: (caller, [options]) =>
      host.windowObject(
        caller.ext,
        host.resolveWindow(caller, -2),
        bag(options).populate === true,
      ),
    getLastFocused: (caller, [options]) => {
      const record = host.tabs.lastFocusedWindow(profile(caller));
      if (!record) throw new Error("No last-focused window.");
      return host.windowObject(
        caller.ext,
        record,
        bag(options).populate === true,
      );
    },
    getAll: (caller, [options]) => {
      const props = bag(options);
      const types = windowTypes(props);
      return host.tabs
        .windowsOf(profile(caller))
        .filter((record) => types.includes(record.type))
        .map((record) =>
          host.windowObject(caller.ext, record, props.populate === true),
        );
    },
    create: async (caller, [options]) => {
      const props = bag(options);
      if (props.incognito === true)
        throw new Error("Work has no incognito windows.");
      if (props.tabId !== undefined)
        throw new Error(
          "Moving a tab to a new window is not supported in Work.",
        );
      const urls = strings(props.url).map((url) => navigable(caller, url));
      if (props.type === "popup" || props.type === "panel") {
        const record = await host.openExtensionWindow(caller.ext, {
          url: urls[0] || "about:blank",
          type: "popup",
          bounds: {
            x: numberOr(props.left, null) ?? undefined,
            y: numberOr(props.top, null) ?? undefined,
            width: numberOr(props.width, null) ?? undefined,
            height: numberOr(props.height, null) ?? undefined,
          },
          focused: props.focused !== false,
        });
        return host.windowObject(caller.ext, record, true);
      }
      // A "normal" window is the person's window: its pages open as tabs.
      const window = host.tabs.lastFocusedWindow(profile(caller));
      if (!window) throw new Error("No browser window is open.");
      for (const [index, url] of urls.entries())
        await host.openInTab(
          profile(caller),
          url || "about:blank",
          index === 0,
          window.window,
        );
      if (props.focused !== false) window.window.focus();
      return host.windowObject(caller.ext, window, true);
    },
    update: (caller, [windowId, options]) => {
      const record = host.resolveWindow(caller, windowId);
      const props = bag(options);
      const { window } = record;
      if (record.openedBy === caller.ext.id) {
        const bounds = window.getBounds();
        window.setBounds({
          x: numberOr(props.left, bounds.x) ?? bounds.x,
          y: numberOr(props.top, bounds.y) ?? bounds.y,
          width: numberOr(props.width, bounds.width) ?? bounds.width,
          height: numberOr(props.height, bounds.height) ?? bounds.height,
        });
      }
      if (props.state === "minimized") window.minimize();
      else if (props.state === "maximized") window.maximize();
      else if (props.state === "fullscreen") window.setFullScreen(true);
      else if (props.state === "normal") {
        if (window.isFullScreen()) window.setFullScreen(false);
        if (window.isMinimized() || window.isMaximized()) window.restore();
      }
      if (props.focused === true) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      if (typeof props.drawAttention === "boolean")
        window.flashFrame(props.drawAttention);
      return host.windowObject(caller.ext, record, false);
    },
    remove: (caller, [windowId]) => {
      const record = host.resolveWindow(caller, windowId);
      if (!record.openedBy)
        throw new Error("Work's windows cannot be closed by an extension.");
      record.window.close();
    },
  });

  // ---- action, browserAction, pageAction --------------------------------------------------

  const actionTab = (caller: Caller, details: Bag): number | null => {
    if (details.tabId === undefined || details.tabId === null) return null;
    return host.tabOf(caller, details.tabId).id;
  };
  const relativePopup = (caller: Caller, raw: unknown): string => {
    if (raw === "" || raw === null || raw === undefined) return "";
    if (typeof raw !== "string") throw new Error("Invalid popup.");
    const url = new URL(raw, `chrome-extension://${caller.ext.id}/`);
    if (url.protocol !== "chrome-extension:" || url.host !== caller.ext.id)
      throw new Error("The popup must be one of the extension's pages.");
    return url.pathname.slice(1) + url.search + url.hash;
  };
  const iconFrom = (caller: Caller, details: Bag): string | null => {
    const imageData = bag(details.imageData);
    const sizes = Object.keys(imageData);
    if (sizes.length > 0) {
      const sorted = sizes
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const size = sorted.find((value) => value >= 32) ?? sorted.at(-1);
      const image = bag(imageData[String(size)]);
      const data = image.data;
      if (
        typeof image.width === "number" &&
        typeof image.height === "number" &&
        data instanceof Uint8Array
      )
        return pixelsDataUrl({
          width: image.width,
          height: image.height,
          data,
        });
      throw new Error("Invalid image data.");
    }
    const path = details.path;
    const file =
      typeof path === "string"
        ? path
        : bestIcon(
            Object.fromEntries(
              Object.entries(bag(path)).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            ),
            32,
          );
    if (!file) throw new Error("Either path or imageData must be specified.");
    const url = fileDataUrl(
      extensionFile(caller.ext.root, caller.ext.id, file),
    );
    if (!url) throw new Error(`Could not load action icon '${file}'.`);
    return url;
  };
  const values = (caller: Caller, tabId: number | null) => {
    const state = host.actions.get(profile(caller), caller.ext.id, tabId);
    if (!state) throw new Error("This extension has no action.");
    return state;
  };
  const set = (
    caller: Caller,
    tabId: number | null,
    change: Parameters<typeof host.actions.set>[3],
  ) => {
    host.actions.set(profile(caller), caller.ext.id, tabId, change);
    host.actionsChanged(profile(caller));
  };
  const actionHandlers: Record<string, ApiHandler> = {
    setTitle: (caller, [details]) => {
      const props = bag(details);
      set(caller, actionTab(caller, props), {
        title: typeof props.title === "string" ? props.title.slice(0, 512) : "",
      });
    },
    getTitle: (caller, [details]) =>
      values(caller, actionTab(caller, bag(details))).title,
    setIcon: (caller, [details]) => {
      const props = bag(details);
      set(caller, actionTab(caller, props), { icon: iconFrom(caller, props) });
    },
    setPopup: (caller, [details]) => {
      const props = bag(details);
      set(caller, actionTab(caller, props), {
        popup: relativePopup(caller, props.popup),
      });
    },
    getPopup: (caller, [details]) => {
      const popup = values(caller, actionTab(caller, bag(details))).popup;
      return popup ? caller.ext.url(popup) : "";
    },
    setBadgeText: (caller, [details]) => {
      const props = bag(details);
      set(caller, actionTab(caller, props), {
        badgeText:
          typeof props.text === "string" ? props.text.slice(0, 64) : "",
      });
    },
    getBadgeText: (caller, [details]) =>
      values(caller, actionTab(caller, bag(details))).badgeText,
    setBadgeBackgroundColor: (caller, [details]) => {
      const props = bag(details);
      const color = parseColor(props.color);
      if (!color)
        throw new Error("The color specification could not be parsed.");
      set(caller, actionTab(caller, props), { badgeBackground: color });
    },
    getBadgeBackgroundColor: (caller, [details]) =>
      values(caller, actionTab(caller, bag(details))).badgeBackground ?? [
        95, 99, 104, 255,
      ],
    setBadgeTextColor: (caller, [details]) => {
      const props = bag(details);
      const color = parseColor(props.color);
      if (!color)
        throw new Error("The color specification could not be parsed.");
      set(caller, actionTab(caller, props), { badgeTextColor: color });
    },
    getBadgeTextColor: (caller, [details]) =>
      values(caller, actionTab(caller, bag(details))).badgeTextColor ?? [
        255, 255, 255, 255,
      ],
    enable: (caller, [tabId]) =>
      set(caller, tabId === undefined ? null : host.tabOf(caller, tabId).id, {
        enabled: true,
      }),
    disable: (caller, [tabId]) =>
      set(caller, tabId === undefined ? null : host.tabOf(caller, tabId).id, {
        enabled: false,
      }),
    isEnabled: (caller, [tabId]) =>
      values(caller, tabId === undefined ? null : host.tabOf(caller, tabId).id)
        .enabled,
    getUserSettings: (caller) => ({ isOnToolbar: caller.ext.record.pinned }),
    openPopup: (caller, [options]) =>
      host.openPopup(caller.ext, numberOr(bag(options).windowId, null)),
  };
  for (const namespace of ["action", "browserAction", "pageAction"])
    define(namespace, (extension) => extension.action !== null, actionHandlers);

  // ---- permissions -------------------------------------------------------------------------

  const permissionSet = (value: unknown) => {
    const props = bag(value);
    return {
      permissions: strings(props.permissions),
      origins: strings(props.origins),
    };
  };
  define("permissions", null, {
    getAll: (caller) => ({
      permissions: [
        ...caller.ext.required.permissions,
        ...caller.ext.granted.permissions,
      ],
      origins: [...caller.ext.required.origins, ...caller.ext.granted.origins],
    }),
    contains: (caller, [value]) => {
      const wanted = permissionSet(value);
      return (
        wanted.permissions.every((permission) => caller.ext.has(permission)) &&
        wanted.origins.every((origin) => caller.ext.holdsOrigin(origin))
      );
    },
    request: (caller, [value]) => {
      if (!caller.gesture)
        throw new Error("This function must be called during a user gesture");
      return host.requestPermissions(caller, permissionSet(value));
    },
    remove: (caller, [value]) =>
      host.removePermissions(caller.ext, permissionSet(value)),
    addHostAccessRequest: () => undefined,
    removeHostAccessRequest: () => undefined,
  });

  // ---- declarativeNetRequest (internal) ------------------------------------------------------

  // The session preload reports which static rulesets are on, so they
  // survive restarts and reset on updates as in Chrome.
  define(
    "declarativeNetRequest",
    (extension) =>
      extension.has("declarativeNetRequest") ||
      extension.has("declarativeNetRequestWithHostAccess"),
    {
      noteEnabledRulesets: (caller, [ids]) =>
        host.noteEnabledRulesets(caller.ext, ids),
    },
  );

  // ---- contextMenus ------------------------------------------------------------------------------

  define("contextMenus", "contextMenus", {
    create: (caller, [properties]) => {
      host.menus.create(profile(caller), caller.ext.id, bag(properties));
      host.saveMenus(caller.ext);
    },
    update: (caller, [id, properties]) => {
      host.menus.update(
        profile(caller),
        caller.ext.id,
        String(id),
        bag(properties),
      );
      host.saveMenus(caller.ext);
    },
    remove: (caller, [id]) => {
      host.menus.remove(profile(caller), caller.ext.id, String(id));
      host.saveMenus(caller.ext);
    },
    removeAll: (caller) => {
      host.menus.removeAll(profile(caller), caller.ext.id);
      host.saveMenus(caller.ext);
    },
  });

  // ---- commands ------------------------------------------------------------------------------------

  define("commands", null, {
    getAll: (caller) => host.commandsOf(caller.ext),
  });

  // ---- sidePanel ----------------------------------------------------------------------------------

  const panelPath = (caller: Caller, raw: unknown): string => {
    if (typeof raw !== "string" || !raw) throw new Error("Invalid path.");
    const url = new URL(raw, `chrome-extension://${caller.ext.id}/`);
    if (url.protocol !== "chrome-extension:" || url.host !== caller.ext.id)
      throw new Error("The side panel must be one of the extension's pages.");
    return url.pathname.slice(1) + url.search;
  };
  const panelTab = (caller: Caller, options: Bag): TabRecord => {
    if (typeof options.tabId === "number")
      return host.tabOf(caller, options.tabId);
    const window = host.resolveWindow(caller, options.windowId);
    const active = host.tabs.activeTab(window.id);
    if (!active) throw new Error("No active tab in that window.");
    return active;
  };
  define("sidePanel", "sidePanel", {
    setOptions: (caller, [options]) => {
      const props = bag(options);
      const tabId =
        typeof props.tabId === "number"
          ? host.tabOf(caller, props.tabId).id
          : -1;
      const current = caller.ext.panelOptions.get(tabId) ?? {};
      if (props.path !== undefined)
        current.path = panelPath(caller, props.path);
      if (typeof props.enabled === "boolean") current.enabled = props.enabled;
      caller.ext.panelOptions.set(tabId, current);
      // An open panel follows its options.
      for (const record of host.tabs.tabsOf(profile(caller))) {
        if (tabId !== -1 && record.id !== tabId) continue;
        const open = host.sidePanelOf(record.id);
        if (open?.extensionId !== caller.ext.id) continue;
        const next = caller.ext.panelFor(record.id);
        if (!next.enabled || !next.path)
          host.closeSidePanel(record.id, caller.ext.id);
        else if (caller.ext.url(next.path) !== open.url)
          host.openSidePanel(caller.ext, record.id);
      }
    },
    getOptions: (caller, [options]) => {
      const props = bag(options);
      const tabId =
        typeof props.tabId === "number"
          ? host.tabOf(caller, props.tabId).id
          : null;
      const panel = caller.ext.panelFor(tabId);
      return {
        ...(panel.path ? { path: panel.path } : {}),
        enabled: panel.enabled,
        ...(tabId !== null ? { tabId } : {}),
      };
    },
    setPanelBehavior: (caller, [behavior]) => {
      const props = bag(behavior);
      if (typeof props.openPanelOnActionClick === "boolean")
        caller.ext.openPanelOnActionClick = props.openPanelOnActionClick;
    },
    getPanelBehavior: (caller) => ({
      openPanelOnActionClick: caller.ext.openPanelOnActionClick,
    }),
    open: (caller, [options]) => {
      host.openSidePanel(caller.ext, panelTab(caller, bag(options)).id);
    },
    close: (caller, [options]) => {
      host.closeSidePanel(panelTab(caller, bag(options)).id, caller.ext.id);
    },
    getLayout: () => ({ side: "right" }),
  });

  // ---- debugger ------------------------------------------------------------------------------------

  const debuggee = (caller: Caller, target: unknown): TabRecord => {
    const props = bag(target);
    if (props.extensionId !== undefined)
      throw new Error("Attaching to extensions is not allowed in Work.");
    const raw =
      typeof props.tabId === "number"
        ? props.tabId
        : typeof props.targetId === "string"
          ? Number(props.targetId.replace(/^tab-/, ""))
          : Number.NaN;
    // The page's address is checked by host.debuggers on every call.
    return host.tabOf(caller, raw);
  };
  const client = (caller: Caller) => `${caller.ext.profileId}:${caller.ext.id}`;
  define("debugger", "debugger", {
    attach: (caller, [target, version]) => {
      const record = debuggee(caller, target);
      host.debuggers.attach(
        client(caller),
        { guest: record.guest, tabId: record.id },
        typeof version === "string" ? version : "1.3",
      );
    },
    detach: (caller, [target]) => {
      host.debuggers.detach(client(caller), debuggee(caller, target).id);
    },
    sendCommand: (caller, [target, method, params]) => {
      const record = debuggee(caller, target);
      if (typeof method !== "string") throw new Error("Invalid method.");
      const sessionId = bag(target).sessionId;
      return host.debuggers.sendCommand(
        client(caller),
        record.id,
        method,
        params === undefined ? undefined : bag(params),
        typeof sessionId === "string" ? sessionId : undefined,
      );
    },
    getTargets: (caller) =>
      host.tabs.tabsOf(profile(caller)).map((record) => ({
        type: "page",
        id: `tab-${record.id}`,
        tabId: record.id,
        title: record.guest.getTitle(),
        url: record.guest.getURL(),
        attached: host.debuggers.isAttached(client(caller), record.id),
        ...(record.favIconUrl ? { faviconUrl: record.favIconUrl } : {}),
      })),
  });

  // ---- tabGroups -------------------------------------------------------------------------------------

  const groupOf = (caller: Caller, groupId: unknown) => {
    const group = typeof groupId === "number" ? host.tabs.group(groupId) : null;
    if (
      !group ||
      host.tabs.window(group.windowId)?.profileId !== profile(caller)
    )
      throw new Error(`No group with id: ${String(groupId)}.`);
    return group;
  };
  define("tabGroups", "tabGroups", {
    get: (caller, [groupId]) => groupObject(groupOf(caller, groupId)),
    query: (caller, [info]) => {
      const props = bag(info);
      const current =
        caller.windowId ??
        host.tabs.lastFocusedWindow(profile(caller))?.id ??
        -1;
      return host.tabs
        .groupsOf(profile(caller))
        .filter((group) => {
          if (
            typeof props.collapsed === "boolean" &&
            group.collapsed !== props.collapsed
          )
            return false;
          if (typeof props.color === "string" && group.color !== props.color)
            return false;
          if (
            typeof props.title === "string" &&
            !globMatches(props.title, group.title)
          )
            return false;
          if (typeof props.windowId === "number") {
            const wanted = props.windowId === -2 ? current : props.windowId;
            if (group.windowId !== wanted) return false;
          }
          return true;
        })
        .map(groupObject);
    },
    update: (caller, [groupId, properties]) => {
      const group = groupOf(caller, groupId);
      const props = bag(properties);
      if (
        props.color !== undefined &&
        !(GROUP_COLORS as readonly unknown[]).includes(props.color)
      )
        throw new Error(`Invalid color: ${String(props.color)}.`);
      return groupObject(
        host.tabs.updateGroup(group.id, {
          ...(typeof props.title === "string"
            ? { title: props.title.slice(0, 256) }
            : {}),
          ...(typeof props.color === "string" ? { color: props.color } : {}),
          ...(typeof props.collapsed === "boolean"
            ? { collapsed: props.collapsed }
            : {}),
        }),
      );
    },
    move: (caller, [groupId]) => groupObject(groupOf(caller, groupId)),
  });

  // ---- webNavigation ---------------------------------------------------------------------------------

  const frameDetails = (record: TabRecord, frame: Electron.WebFrameMain) => {
    const ids = frameIds(record.guest, frame);
    return {
      errorOccurred: false,
      url: frame.url,
      frameId: ids.frameId,
      parentFrameId: ids.parentFrameId,
      processId: frame.osProcessId,
      documentLifecycle: "active",
      frameType: ids.frameId === 0 ? "outermost_frame" : "sub_frame",
    };
  };
  define("webNavigation", "webNavigation", {
    getFrame: (caller, [details]) => {
      const props = bag(details);
      const record = host.tabOf(caller, props.tabId);
      const frame = frameById(record.guest, numberOr(props.frameId, 0) ?? 0);
      return frame ? frameDetails(record, frame) : null;
    },
    getAllFrames: (caller, [details]) => {
      const record = host.tabOf(caller, bag(details).tabId);
      return record.guest.mainFrame.framesInSubtree.map((frame) =>
        frameDetails(record, frame),
      );
    },
  });

  // ---- notifications -----------------------------------------------------------------------------------

  const shown = new Map<string, Notification>();
  let nextNotification = 1;
  const notificationKey = (caller: Caller, id: string) =>
    `${profile(caller)}:${caller.ext.id}:${id}`;
  const showNotification = (caller: Caller, id: string, options: Bag) => {
    const iconUrl =
      typeof options.iconUrl === "string" ? options.iconUrl : null;
    let icon: Electron.NativeImage | undefined;
    if (iconUrl?.startsWith("data:image/"))
      icon = nativeImage.createFromDataURL(iconUrl);
    else if (iconUrl) {
      const file = extensionFile(caller.ext.root, caller.ext.id, iconUrl);
      if (file) icon = nativeImage.createFromPath(file);
    }
    const buttons = Array.isArray(options.buttons)
      ? options.buttons.slice(0, 2)
      : [];
    const notification = new Notification({
      title:
        typeof options.title === "string" ? options.title : caller.ext.name,
      subtitle: caller.ext.name,
      body: [options.message, options.contextMessage]
        .filter(
          (part): part is string => typeof part === "string" && part !== "",
        )
        .join("\n"),
      silent: options.silent === true,
      ...(icon && !icon.isEmpty() ? { icon } : {}),
      actions: buttons.map((button) => ({
        type: "button" as const,
        text: String(bag(button).title ?? ""),
      })),
    });
    const key = notificationKey(caller, id);
    const { profileId } = caller.ext;
    const extensionId = caller.ext.id;
    notification.on("click", () => {
      host.noteGesture(profileId, extensionId);
      host.events.dispatch(profileId, extensionId, "notifications.onClicked", [
        id,
      ]);
    });
    notification.on("action", (_event, index) => {
      host.noteGesture(profileId, extensionId);
      host.events.dispatch(
        profileId,
        extensionId,
        "notifications.onButtonClicked",
        [id, index],
      );
    });
    notification.on("close", () => {
      if (shown.get(key) !== notification) return;
      shown.delete(key);
      host.events.dispatch(profileId, extensionId, "notifications.onClosed", [
        id,
        true,
      ]);
    });
    shown.get(key)?.close();
    shown.set(key, notification);
    notification.show();
  };
  define("notifications", "notifications", {
    create: (caller, args) => {
      const [first, second] = args;
      const id =
        typeof first === "string" && first !== ""
          ? first
          : `${caller.ext.id}-${nextNotification++}`;
      showNotification(
        caller,
        id,
        bag(typeof first === "string" ? second : first),
      );
      return id;
    },
    update: (caller, [id, options]) => {
      const key = notificationKey(caller, String(id));
      if (!shown.has(key)) return false;
      showNotification(caller, String(id), bag(options));
      return true;
    },
    clear: (caller, [id]) => {
      const key = notificationKey(caller, String(id));
      const notification = shown.get(key);
      if (!notification) return false;
      shown.delete(key);
      notification.close();
      return true;
    },
    getAll: (caller) => {
      const prefix = notificationKey(caller, "");
      return Object.fromEntries(
        [...shown.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => [key.slice(prefix.length), true]),
      );
    },
    getPermissionLevel: () => "granted",
  });

  // ---- downloads ------------------------------------------------------------------------------------------

  const downloadIds = new Map<string, number>();
  const downloadKeys = new Map<number, string>();
  let nextDownload = 1;
  const downloadId = (key: string) => {
    let id = downloadIds.get(key);
    if (id === undefined) {
      id = nextDownload++;
      downloadIds.set(key, id);
      downloadKeys.set(id, key);
    }
    return id;
  };
  type DownloadRecord = ReturnType<ExtensionsHost["downloads"]["list"]>[number];
  const downloadItem = (record: DownloadRecord) => ({
    id: downloadId(record.id),
    url: record.url,
    finalUrl: record.url,
    referrer: "",
    filename: record.savePath,
    incognito: false,
    danger: "safe",
    mime: record.mimeType,
    startTime: new Date(record.startedAt).toISOString(),
    ...(record.finishedAt
      ? { endTime: new Date(record.finishedAt).toISOString() }
      : {}),
    state:
      record.state === "completed"
        ? "complete"
        : record.state === "cancelled" || record.state === "interrupted"
          ? "interrupted"
          : "in_progress",
    ...(record.state === "cancelled" ? { error: "USER_CANCELED" } : {}),
    ...(record.state === "interrupted" ? { error: "NETWORK_FAILED" } : {}),
    paused: record.state === "paused",
    canResume: record.canResume,
    bytesReceived: record.receivedBytes,
    totalBytes: record.totalBytes,
    fileSize: record.totalBytes,
    exists: record.exists,
  });
  const downloadsOf = (caller: Caller) => host.downloads.list(profile(caller));
  const recordFor = (caller: Caller, id: unknown): DownloadRecord => {
    const key = typeof id === "number" ? downloadKeys.get(id) : undefined;
    const record = downloadsOf(caller).find((entry) => entry.id === key);
    if (!record) throw new Error("Invalid download id.");
    return record;
  };
  const searchDownloads = (caller: Caller, query: Bag) => {
    let records = downloadsOf(caller).map(downloadItem);
    if (typeof query.id === "number")
      records = records.filter((item) => item.id === query.id);
    if (typeof query.url === "string")
      records = records.filter((item) => item.url === query.url);
    if (typeof query.state === "string")
      records = records.filter((item) => item.state === query.state);
    if (typeof query.filename === "string")
      records = records.filter((item) => item.filename === query.filename);
    if (typeof query.exists === "boolean")
      records = records.filter((item) => item.exists === query.exists);
    const terms = strings(query.query);
    if (terms.length > 0)
      records = records.filter((item) =>
        terms.every((term) =>
          term.startsWith("-")
            ? !`${item.url} ${item.filename}`.includes(term.slice(1))
            : `${item.url} ${item.filename}`.includes(term),
        ),
      );
    const limit = numberOr(query.limit, 1000) ?? 1000;
    return limit > 0 ? records.slice(0, limit) : records;
  };
  // Downloads change → onCreated / onChanged for listening extensions.
  // Downloads from before this run are not new to anyone.
  const runStartedAt = Date.now();
  const seen = new Map<string, Map<string, ReturnType<typeof downloadItem>>>();
  host.downloads.onChange((profileId) => {
    const previous = seen.get(profileId) ?? new Map();
    const next = new Map<string, ReturnType<typeof downloadItem>>();
    const fire = (name: string, args: unknown[]) => {
      for (const extension of host.loadedIn(profileId))
        if (extension.has("downloads"))
          host.events.dispatch(profileId, extension.id, name, args);
    };
    for (const record of host.downloads.list(profileId)) {
      const item = downloadItem(record);
      next.set(record.id, item);
      const before = previous.get(record.id);
      if (!before) {
        if (record.startedAt >= runStartedAt)
          fire("downloads.onCreated", [item]);
        continue;
      }
      const delta: Bag = { id: item.id };
      for (const field of [
        "state",
        "paused",
        "error",
        "filename",
        "totalBytes",
        "exists",
        "endTime",
      ] as const) {
        const was = (before as Bag)[field];
        const now = (item as Bag)[field];
        if (was !== now) delta[field] = { previous: was, current: now };
      }
      if (Object.keys(delta).length > 1) fire("downloads.onChanged", [delta]);
    }
    for (const [id, item] of previous)
      if (!next.has(id)) fire("downloads.onErased", [item.id]);
    seen.set(profileId, next);
  });
  define("downloads", "downloads", {
    download: async (caller, [options]) => {
      const props = bag(options);
      const url = typeof props.url === "string" ? props.url : "";
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Invalid URL.");
      }
      if (!["http:", "https:", "data:", "blob:"].includes(parsed.protocol))
        throw new Error("Invalid URL.");
      const session = host.session(profile(caller));
      if (!session) throw new Error("The extension is not running.");
      const filename =
        typeof props.filename === "string" && props.filename
          ? (props.filename.split(/[\\/]/).at(-1) ?? null)
          : null;
      // Chromium names the item by the parsed address, as URL parses it.
      const started = host.downloads.expect(
        profile(caller),
        parsed.href,
        filename,
      );
      const headers = Object.fromEntries(
        (Array.isArray(props.headers) ? props.headers : []).flatMap(
          (header) => {
            const entry = bag(header);
            return typeof entry.name === "string" &&
              typeof entry.value === "string"
              ? [[entry.name, entry.value]]
              : [];
          },
        ),
      );
      session.downloadURL(
        parsed.href,
        Object.keys(headers).length > 0 ? { headers } : {},
      );
      const id = await started;
      if (!id) throw new Error("The download did not start.");
      return downloadId(id);
    },
    search: (caller, [query]) => searchDownloads(caller, bag(query)),
    pause: (caller, [id]) => host.downloads.pause(recordFor(caller, id).id),
    resume: (caller, [id]) => host.downloads.resume(recordFor(caller, id).id),
    cancel: (caller, [id]) => host.downloads.cancel(recordFor(caller, id).id),
    erase: (caller, [query]) => {
      const items = searchDownloads(caller, bag(query));
      for (const item of items) {
        const key = downloadKeys.get(item.id);
        if (key) host.downloads.remove(profile(caller), key);
      }
      return items.map((item) => item.id);
    },
    show: (caller, [id]) => {
      shell.showItemInFolder(recordFor(caller, id).savePath);
      return true;
    },
    showDefaultFolder: () => {
      void shell.openPath(app.getPath("downloads"));
    },
    open: () => {
      throw new Error(
        "Opening downloaded files from an extension is not allowed in Work.",
      );
    },
    removeFile: () => {
      throw new Error(
        "Removing downloaded files from an extension is not allowed in Work.",
      );
    },
    getFileIcon: () => undefined,
    setUiOptions: () => undefined,
    setShelfEnabled: () => undefined,
    acceptDanger: () => undefined,
  });

  // ---- identity ---------------------------------------------------------------------------------------------

  define("identity", "identity", {
    launchWebAuthFlow: async (caller, [details]) => {
      const props = bag(details);
      const url = typeof props.url === "string" ? props.url : "";
      if (!/^https?:\/\//i.test(url))
        throw new Error("Authorization page could not be loaded.");
      const interactive = props.interactive === true;
      const redirect = `https://${caller.ext.id}.chromiumapp.org/`;
      const record = await host.openExtensionWindow(caller.ext, {
        url,
        type: "popup",
        bounds: { width: 520, height: 680 },
        focused: true,
        show: interactive,
        track: false,
      });
      const { window } = record;
      return new Promise<string>((resolve, reject) => {
        let done = false;
        const finish = (outcome: { url: string } | { error: string }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!window.isDestroyed()) window.destroy();
          if ("url" in outcome) resolve(outcome.url);
          else reject(new Error(outcome.error));
        };
        const watch = (event: Electron.Event, target: string) => {
          if (!target.startsWith(redirect)) return;
          event.preventDefault();
          finish({ url: target });
        };
        window.webContents.on("will-redirect", (event, target) =>
          watch(event, target),
        );
        window.webContents.on("will-navigate", (event, target) =>
          watch(event, target),
        );
        window.webContents.on("did-start-navigation", (details) => {
          if (details.url.startsWith(redirect)) finish({ url: details.url });
        });
        window.on("closed", () =>
          finish({ error: "The user did not approve access." }),
        );
        const timeout = interactive
          ? 30 * 60 * 1000
          : (numberOr(props.timeoutMsForNonInteractive, null) ?? 5000);
        const timer = setTimeout(
          () =>
            finish({
              error: interactive
                ? "The user did not approve access."
                : "User interaction required.",
            }),
          timeout,
        );
      });
    },
    getAuthToken: () => {
      throw new Error("The user is not signed in.");
    },
    getProfileUserInfo: () => ({ email: "", id: "" }),
    removeCachedAuthToken: () => undefined,
    clearAllCachedAuthTokens: () => undefined,
    getAccounts: () => [],
  });

  // ---- bookmarks (read only) -------------------------------------------------------------------------

  const bookmarkTree = (caller: Caller) => {
    const store = host.bookmarks();
    const tree = (
      prefix: string,
      rootId: string,
      title: string,
      source: ReturnType<typeof store.pinned>,
    ) => {
      const children = (
        parentId: string | undefined,
        parentNode: string,
      ): Bag[] => {
        const folders = source.folders
          .filter((folder) => folder.parentId === parentId)
          .map((folder) => ({ position: folder.position ?? 0, folder }));
        const marks = source.bookmarks
          .filter((mark) => mark.folderId === parentId)
          .map((mark) => ({ position: mark.position ?? 0, mark }));
        return [...folders, ...marks]
          .sort((a, b) => a.position - b.position)
          .map((entry, index) =>
            "folder" in entry
              ? {
                  id: `${prefix}${entry.folder.id}`,
                  parentId: parentNode,
                  index,
                  title: entry.folder.label,
                  dateAdded: 0,
                  children: children(
                    entry.folder.id,
                    `${prefix}${entry.folder.id}`,
                  ),
                }
              : {
                  id: `${prefix}${entry.mark.id}`,
                  parentId: parentNode,
                  index,
                  title: entry.mark.label,
                  url: entry.mark.url,
                  dateAdded: 0,
                },
          );
      };
      return {
        id: rootId,
        parentId: "0",
        index: rootId === "1" ? 0 : 1,
        title,
        dateAdded: 0,
        folderType: rootId === "1" ? "bookmarks-bar" : "other",
        children: children(undefined, rootId),
      };
    };
    return {
      id: "0",
      title: "",
      dateAdded: 0,
      children: [
        tree("p-", "1", "Bookmarks bar", store.pinned(profile(caller))),
        tree("l-", "2", "Other bookmarks", store.library(profile(caller))),
      ],
    };
  };
  const flatten = (node: Bag): Bag[] => [
    node,
    ...(Array.isArray(node.children)
      ? node.children.flatMap((child) => flatten(bag(child)))
      : []),
  ];
  const nodeById = (caller: Caller, id: unknown): Bag => {
    const node = flatten(bookmarkTree(caller)).find(
      (entry) => entry.id === String(id),
    );
    if (!node) throw new Error("Can't find bookmark for id.");
    return node;
  };
  const readOnly = () => {
    throw new Error("Bookmarks are read only for extensions in Work.");
  };
  define("bookmarks", "bookmarks", {
    getTree: (caller) => [bookmarkTree(caller)],
    getSubTree: (caller, [id]) => [nodeById(caller, id)],
    get: (caller, [ids]) =>
      (Array.isArray(ids) ? ids : [ids]).map((id) => {
        const { children: _children, ...node } = nodeById(caller, id);
        return node;
      }),
    getChildren: (caller, [id]) =>
      (Array.isArray(nodeById(caller, id).children)
        ? (nodeById(caller, id).children as Bag[])
        : []
      ).map(({ children: _children, ...node }) => node),
    getRecent: (caller, [count]) =>
      flatten(bookmarkTree(caller))
        .filter((node) => typeof node.url === "string")
        .slice(0, Math.max(1, numberOr(count, 10) ?? 10)),
    search: (caller, [query]) => {
      const text =
        typeof query === "string" ? query : String(bag(query).query ?? "");
      const url = typeof query === "string" ? undefined : bag(query).url;
      const title = typeof query === "string" ? undefined : bag(query).title;
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      return flatten(bookmarkTree(caller)).filter((node) => {
        if (typeof node.url !== "string") return false;
        if (typeof url === "string" && node.url !== url) return false;
        if (typeof title === "string" && node.title !== title) return false;
        const haystack = `${String(node.title)} ${node.url}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      });
    },
    create: readOnly,
    move: readOnly,
    update: readOnly,
    remove: readOnly,
    removeTree: readOnly,
  });

  // ---- history, topSites, sessions (read only) ------------------------------------------------------

  const webHistory = (caller: Caller) =>
    host
      .historyEntries(profile(caller))
      .filter(
        (entry) =>
          entry.target.kind === "web" && typeof entry.target.url === "string",
      );
  const historyReadOnly = () => {
    throw new Error("History is read only for extensions in Work.");
  };
  define("history", "history", {
    search: (caller, [query]) => {
      const props = bag(query);
      const words = String(props.text ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const start =
        numberOr(props.startTime, Date.now() - 24 * 60 * 60 * 1000) ?? 0;
      const end =
        numberOr(props.endTime, Number.POSITIVE_INFINITY) ??
        Number.POSITIVE_INFINITY;
      const max = numberOr(props.maxResults, 100) ?? 100;
      return webHistory(caller)
        .filter(
          (entry) => entry.lastVisitAt >= start && entry.lastVisitAt <= end,
        )
        .filter((entry) => {
          const haystack =
            `${entry.title} ${entry.target.url ?? ""}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
        .sort((a, b) => b.lastVisitAt - a.lastVisitAt)
        .slice(0, max > 0 ? max : undefined)
        .map((entry) => ({
          id: entry.id,
          url: entry.target.url,
          title: entry.title,
          lastVisitTime: entry.lastVisitAt,
          visitCount: entry.visitCount,
          typedCount: 0,
        }));
    },
    getVisits: (caller, [details]) => {
      const url = bag(details).url;
      return webHistory(caller)
        .filter((entry) => entry.target.url === url)
        .map((entry) => ({
          id: entry.id,
          visitId: entry.id,
          visitTime: entry.lastVisitAt,
          referringVisitId: "0",
          transition: "link",
          isLocal: true,
        }));
    },
    addUrl: historyReadOnly,
    deleteUrl: historyReadOnly,
    deleteRange: historyReadOnly,
    deleteAll: historyReadOnly,
  });
  define("topSites", "topSites", {
    get: (caller) =>
      [...webHistory(caller)]
        .sort((a, b) => b.visitCount - a.visitCount)
        .slice(0, 10)
        .map((entry) => ({ url: entry.target.url, title: entry.title })),
  });
  define("sessions", "sessions", {
    getRecentlyClosed: () => [],
    getDevices: () => [],
    restore: () => {
      throw new Error("There are no sessions to restore.");
    },
  });

  // ---- fontSettings --------------------------------------------------------------------------------------

  const fontsReadOnly = () => {
    throw new Error("Font settings cannot be changed by extensions in Work.");
  };
  const control = { levelOfControl: "not_controllable" };
  define("fontSettings", "fontSettings", {
    getFontList: () =>
      COMMON_FONTS.map((name) => ({ fontId: name, displayName: name })),
    getFont: () => ({ fontId: "", ...control }),
    getDefaultFontSize: () => ({ pixelSize: 16, ...control }),
    getDefaultFixedFontSize: () => ({ pixelSize: 13, ...control }),
    getMinimumFontSize: () => ({ pixelSize: 0, ...control }),
    setFont: fontsReadOnly,
    clearFont: fontsReadOnly,
    setDefaultFontSize: fontsReadOnly,
    clearDefaultFontSize: fontsReadOnly,
    setDefaultFixedFontSize: fontsReadOnly,
    clearDefaultFixedFontSize: fontsReadOnly,
    setMinimumFontSize: fontsReadOnly,
    clearMinimumFontSize: fontsReadOnly,
  });

  // ---- cookies ---------------------------------------------------------------------------------------------

  const cookieUrl = (cookie: Electron.Cookie) =>
    `${cookie.secure ? "https" : "http"}://${(cookie.domain ?? "").replace(/^\./, "")}${cookie.path ?? "/"}`;
  const chromeCookie = (cookie: Electron.Cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    hostOnly: cookie.hostOnly ?? false,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite:
      cookie.sameSite === "no_restriction"
        ? "no_restriction"
        : (cookie.sameSite ?? "unspecified"),
    session: cookie.session ?? true,
    ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
    storeId: "0",
  });
  const cookieSession = (caller: Caller) => {
    const session = host.session(profile(caller));
    if (!session) throw new Error("The extension is not running.");
    return session;
  };
  const requireHost = (caller: Caller, url: string) => {
    if (!matchesAny(caller.ext.hostPatterns(), url))
      throw new Error(`No host permissions for cookies at url: "${url}".`);
  };
  define("cookies", "cookies", {
    get: async (caller, [details]) => {
      const props = bag(details);
      const url = String(props.url ?? "");
      requireHost(caller, url);
      const [cookie] = await cookieSession(caller).cookies.get({
        url,
        name: String(props.name ?? ""),
      });
      return cookie ? chromeCookie(cookie) : null;
    },
    getAll: async (caller, [details]) => {
      const props = bag(details);
      const filter: Electron.CookiesGetFilter = {};
      if (typeof props.url === "string") filter.url = props.url;
      if (typeof props.name === "string") filter.name = props.name;
      if (typeof props.domain === "string") filter.domain = props.domain;
      if (typeof props.path === "string") filter.path = props.path;
      if (typeof props.secure === "boolean") filter.secure = props.secure;
      if (typeof props.session === "boolean") filter.session = props.session;
      const cookies = await cookieSession(caller).cookies.get(filter);
      return cookies
        .filter((cookie) =>
          matchesAny(caller.ext.hostPatterns(), cookieUrl(cookie)),
        )
        .map(chromeCookie);
    },
    set: async (caller, [details]) => {
      const props = bag(details);
      const url = String(props.url ?? "");
      requireHost(caller, url);
      const sameSite =
        props.sameSite === "no_restriction" ||
        props.sameSite === "lax" ||
        props.sameSite === "strict"
          ? props.sameSite
          : undefined;
      await cookieSession(caller).cookies.set({
        url,
        ...(typeof props.name === "string" ? { name: props.name } : {}),
        ...(typeof props.value === "string" ? { value: props.value } : {}),
        ...(typeof props.domain === "string" ? { domain: props.domain } : {}),
        ...(typeof props.path === "string" ? { path: props.path } : {}),
        ...(typeof props.secure === "boolean" ? { secure: props.secure } : {}),
        ...(typeof props.httpOnly === "boolean"
          ? { httpOnly: props.httpOnly }
          : {}),
        ...(typeof props.expirationDate === "number"
          ? { expirationDate: props.expirationDate }
          : {}),
        ...(sameSite ? { sameSite } : {}),
      });
      const [cookie] = await cookieSession(caller).cookies.get({
        url,
        name: String(props.name ?? ""),
      });
      return cookie ? chromeCookie(cookie) : null;
    },
    remove: async (caller, [details]) => {
      const props = bag(details);
      const url = String(props.url ?? "");
      const name = String(props.name ?? "");
      requireHost(caller, url);
      await cookieSession(caller).cookies.remove(url, name);
      return { url, name, storeId: "0" };
    },
    getAllCookieStores: (caller) => [
      {
        id: "0",
        tabIds: host.tabs.tabsOf(profile(caller)).map((record) => record.id),
      },
    ],
  });

  // ---- storage.sync ---------------------------------------------------------------------------------------------

  const syncChanged = (caller: Caller, changes: Bag) => {
    if (Object.keys(changes).length === 0) return;
    host.events.dispatch(
      profile(caller),
      caller.ext.id,
      "storage.sync.onChanged",
      [changes],
    );
  };
  define("storage.sync", "storage", {
    get: (caller, [keys]) =>
      host.syncStorage.get(profile(caller), caller.ext.id, keys),
    getKeys: (caller) => host.syncStorage.keys(profile(caller), caller.ext.id),
    getBytesInUse: (caller, [keys]) =>
      host.syncStorage.bytesInUse(profile(caller), caller.ext.id, keys),
    set: (caller, [items]) =>
      syncChanged(
        caller,
        host.syncStorage.set(profile(caller), caller.ext.id, items),
      ),
    remove: (caller, [keys]) =>
      syncChanged(
        caller,
        host.syncStorage.remove(profile(caller), caller.ext.id, keys),
      ),
    clear: (caller) =>
      syncChanged(
        caller,
        host.syncStorage.clear(profile(caller), caller.ext.id),
      ),
    setAccessLevel: () => undefined,
  });

  // ---- runtime, management ------------------------------------------------------------------------------------

  define("runtime", null, {
    openOptionsPage: async (caller) => {
      const url = caller.ext.optionsUrl();
      if (!url) throw new Error("Could not create an options page.");
      await host.openInTab(profile(caller), url, true, windowFor(caller));
    },
    setUninstallURL: (caller, [url]) => {
      const value = typeof url === "string" ? url : "";
      if (value && (!/^https?:\/\//i.test(value) || value.length > 1023))
        throw new Error("Invalid URL.");
      host.registry.update(profile(caller), caller.ext.id, (record) => ({
        ...record,
        uninstallUrl: value || null,
      }));
    },
    getContexts: (caller, [filter]) => {
      const props = bag(filter);
      const contexts = host.contextsOf(caller.ext);
      const pick = (name: string, value: unknown) => {
        const wanted = props[name];
        return !Array.isArray(wanted) || wanted.includes(value);
      };
      return contexts.filter(
        (context) =>
          pick("contextTypes", context.contextType) &&
          pick("contextIds", context.contextId) &&
          pick("tabIds", context.tabId) &&
          pick("windowIds", context.windowId) &&
          pick("frameIds", context.frameId) &&
          pick("documentUrls", context.documentUrl) &&
          pick("documentOrigins", context.documentOrigin) &&
          (typeof props.incognito !== "boolean" || props.incognito === false),
      );
    },
    requestUpdateCheck: () => ({ status: "no_update" }),
    sendNativeMessage: (caller, [application, message]) =>
      host.sendNativeMessage(caller.ext, String(application ?? ""), message),
  });
  define("management", null, {
    uninstallSelf: async (caller, [options]) => {
      const window = windowFor(caller);
      if (bag(options).showConfirmDialog === true) {
        const removed = await host.confirmRemove(
          profile(caller),
          caller.ext.id,
          window,
        );
        if (!removed) throw new Error("User cancelled uninstall.");
        return;
      }
      await host.uninstall(profile(caller), caller.ext.id);
    },
  });

  return api;
}
