/**
 * The `chrome.*` APIs Work hosts for extensions (ADR 0203), installed in an
 * extension page's or service worker's main world before its own code runs.
 *
 * This function is serialized into the main world by `executeInMainWorld`:
 * it may not close over anything outside its own body. It reaches main only
 * through the bridge the preload exposed as `__workExtensionHost`, which it
 * takes and deletes before the extension's code runs. Main decides what a
 * call may do from the IPC sender, so nothing here is a security boundary;
 * this file only gives calls Chrome's shape (promises or callbacks,
 * `runtime.lastError`, events, enums).
 */

export interface ExtensionHostBridge {
  call: (method: string, args: unknown[]) => Promise<unknown>;
  send: (channel: string, args: unknown[]) => void;
  onEvent: (listener: (name: string, args: unknown[]) => void) => void;
  /** Synchronous: what main says before the extension's code runs. */
  boot: () => ExtensionBoot | null;
}

export interface ExtensionBoot {
  /** Optional permissions granted earlier. */
  granted: string[];
  /**
   * The static rulesets that should be on: the manifest's defaults after
   * install or update, then whatever the extension last chose.
   */
  rulesets: string[] | null;
}

export function installExtensionApis(): void {
  type Fn = (...args: unknown[]) => unknown;
  type Bag = Record<string, unknown>;
  const scope = globalThis as unknown as Bag;
  const host = scope.__workExtensionHost as ExtensionHostBridge | undefined;
  delete scope.__workExtensionHost;
  const chrome = scope.chrome as Bag | undefined;
  const runtime = chrome?.runtime as Bag | undefined;
  if (!host || !chrome || !runtime || typeof runtime.id !== "string") return;
  // Chromium also exposes a `browser` namespace; uBlock Origin Lite reads it.
  const browserNamespace =
    scope.browser && scope.browser !== chrome
      ? (scope.browser as Bag)
      : undefined;
  const manifest = (runtime.getManifest as () => Bag)();
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const isHost = (value: string) =>
    value === "<all_urls>" || value.includes("://");
  const permissions = new Set(
    strings(manifest.permissions).filter((value) => !isHost(value)),
  );
  const optional = new Set(
    strings(manifest.optional_permissions).filter((value) => !isHost(value)),
  );
  const manifestVersion = manifest.manifest_version === 2 ? 2 : 3;
  const boot = host.boot();
  // Chrome enables a manifest's default rulesets at install and on every
  // update, and keeps the extension's choice across restarts; Electron does
  // neither. Main keeps the choice; this restores it as the extension
  // starts, and reports every change the extension makes.
  const rulesets = boot?.rulesets;
  const dnr = chrome.declarativeNetRequest as Bag | undefined;
  if (
    rulesets &&
    dnr &&
    typeof dnr.updateEnabledRulesets === "function" &&
    typeof dnr.getEnabledRulesets === "function"
  ) {
    const update = (dnr.updateEnabledRulesets as Fn).bind(dnr);
    const getEnabled = (dnr.getEnabledRulesets as Fn).bind(dnr);
    const note = () =>
      Promise.resolve(getEnabled())
        .then((ids) =>
          host.call("declarativeNetRequest.noteEnabledRulesets", [ids]),
        )
        .catch(() => {});
    Promise.resolve(getEnabled())
      .then((current) => {
        const on = Array.isArray(current) ? current : [];
        const enableRulesetIds = rulesets.filter((id) => !on.includes(id));
        const disableRulesetIds = on.filter(
          (id): id is string =>
            typeof id === "string" && !rulesets.includes(id),
        );
        if (enableRulesetIds.length + disableRulesetIds.length === 0)
          return note();
        return Promise.resolve(
          update({ enableRulesetIds, disableRulesetIds }),
        ).then(note);
      })
      .catch((error: unknown) =>
        console.error("Work could not restore the rulesets:", error),
      );
    dnr.updateEnabledRulesets = (options: unknown, callback?: unknown) => {
      if (typeof callback === "function")
        return update(options, (...args: unknown[]) => {
          void note();
          (callback as Fn)(...args);
        });
      const result = update(options);
      if (result instanceof Promise) result.then(note, () => {});
      return result;
    };
  }
  for (const permission of boot?.granted ?? [])
    if (optional.has(permission)) permissions.add(permission);

  // ---- Errors, callbacks and promises -------------------------------------

  const withLastError = (message: string, run: () => void) => {
    const error = { message };
    let defined = false;
    try {
      Object.defineProperty(runtime, "lastError", {
        configurable: true,
        enumerable: true,
        get: () => error,
      });
      defined = true;
    } catch {
      // A runtime without a configurable lastError keeps Chrome's own.
    }
    try {
      run();
    } finally {
      if (defined) delete runtime.lastError;
    }
  };

  const plain = (value: unknown, depth = 0): unknown => {
    if (depth > 32 || typeof value === "function" || typeof value === "symbol")
      return undefined;
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (Array.isArray(value))
      return value.map((item) => plain(item, depth + 1));
    const out: Bag = {};
    for (const [key, item] of Object.entries(value)) {
      const copied = plain(item, depth + 1);
      if (copied !== undefined) out[key] = copied;
    }
    return out;
  };

  /** A Chrome API method: a promise, or the callback Chrome would call. */
  const method =
    (name: string, prepare?: (args: unknown[]) => unknown[]): Fn =>
    (...input: unknown[]) => {
      const callback =
        typeof input[input.length - 1] === "function"
          ? (input.pop() as Fn)
          : null;
      // Trailing undefined arguments are Chrome's "omitted".
      while (input.length > 0 && input[input.length - 1] === undefined)
        input.pop();
      let args: unknown[];
      try {
        args = (prepare ? prepare(input) : input).map((arg) => plain(arg));
      } catch (error) {
        if (callback) {
          withLastError(
            error instanceof Error ? error.message : String(error),
            () => callback(),
          );
          return undefined;
        }
        return Promise.reject(error);
      }
      const result = host.call(name, args);
      if (!callback) return result;
      result.then(
        (value) => callback(value),
        (error: unknown) =>
          withLastError(
            error instanceof Error ? error.message : String(error),
            () => callback(),
          ),
      );
      return undefined;
    };

  // ---- Events ----------------------------------------------------------------

  interface EventEntry {
    listeners: Map<Fn, unknown>;
    matches?: (filter: unknown, args: unknown[]) => boolean;
  }
  const events = new Map<string, EventEntry>();

  const urlFilterMatches = (filter: unknown, url: string): boolean => {
    if (!filter || typeof filter !== "object") return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const f = filter as Bag;
    const text = (key: string) =>
      typeof f[key] === "string" ? (f[key] as string) : null;
    const host = parsed.hostname;
    const path = parsed.pathname;
    const query = parsed.search.replace(/^\?/, "");
    const href = parsed.href;
    const checks: [string | null, (value: string) => boolean][] = [
      [text("hostContains"), (v) => host.includes(v)],
      [text("hostEquals"), (v) => host === v],
      [text("hostPrefix"), (v) => host.startsWith(v)],
      [text("hostSuffix"), (v) => host.endsWith(v)],
      [text("pathContains"), (v) => path.includes(v)],
      [text("pathEquals"), (v) => path === v],
      [text("pathPrefix"), (v) => path.startsWith(v)],
      [text("pathSuffix"), (v) => path.endsWith(v)],
      [text("queryContains"), (v) => query.includes(v)],
      [text("queryEquals"), (v) => query === v],
      [text("queryPrefix"), (v) => query.startsWith(v)],
      [text("querySuffix"), (v) => query.endsWith(v)],
      [text("urlContains"), (v) => href.includes(v)],
      [text("urlEquals"), (v) => href === v],
      [text("urlPrefix"), (v) => href.startsWith(v)],
      [text("urlSuffix"), (v) => href.endsWith(v)],
      [
        text("urlMatches"),
        (v) => {
          try {
            return new RegExp(v).test(href);
          } catch {
            return false;
          }
        },
      ],
      [
        text("originAndPathMatches"),
        (v) => {
          try {
            return new RegExp(v).test(`${parsed.origin}${path}`);
          } catch {
            return false;
          }
        },
      ],
    ];
    for (const [value, check] of checks)
      if (value !== null && !check(value)) return false;
    const schemes = strings(f.schemes);
    if (schemes.length > 0 && !schemes.includes(parsed.protocol.slice(0, -1)))
      return false;
    if (Array.isArray(f.ports)) {
      const port = Number(
        parsed.port ||
          (parsed.protocol === "https:"
            ? 443
            : parsed.protocol === "http:"
              ? 80
              : 0),
      );
      const ok = f.ports.some((entry: unknown) =>
        Array.isArray(entry)
          ? port >= Number(entry[0]) && port <= Number(entry[1])
          : port === Number(entry),
      );
      if (!ok) return false;
    }
    return true;
  };
  const navigationFilter = (filter: unknown, args: unknown[]) => {
    const urls = (filter as Bag | undefined)?.url;
    if (!Array.isArray(urls) || urls.length === 0) return true;
    const url = (args[0] as Bag | undefined)?.url;
    return (
      typeof url === "string" &&
      urls.some((entry) => urlFilterMatches(entry, url))
    );
  };

  /** A Chrome event whose firing main delivers by name. */
  const event = (name: string, matches?: EventEntry["matches"]) => {
    const entry: EventEntry = { listeners: new Map(), matches };
    events.set(name, entry);
    return {
      addListener(listener: unknown, filter?: unknown) {
        if (typeof listener !== "function")
          throw new TypeError("The listener must be a function.");
        const first = entry.listeners.size === 0;
        entry.listeners.set(listener as Fn, filter);
        if (first) host.send("listen", [name, true]);
      },
      removeListener(listener: unknown) {
        if (
          entry.listeners.delete(listener as Fn) &&
          entry.listeners.size === 0
        )
          host.send("listen", [name, false]);
      },
      hasListener: (listener: unknown) => entry.listeners.has(listener as Fn),
      hasListeners: () => entry.listeners.size > 0,
    };
  };

  /** An event fired only from inside this context. */
  const localEvent = () => {
    const listeners = new Set<Fn>();
    return {
      addListener: (listener: Fn) => void listeners.add(listener),
      removeListener: (listener: Fn) => void listeners.delete(listener),
      hasListener: (listener: Fn) => listeners.has(listener),
      hasListeners: () => listeners.size > 0,
      fire: (...args: unknown[]) => {
        for (const listener of [...listeners]) {
          try {
            listener(...args);
          } catch (error) {
            console.error(error);
          }
        }
      },
    };
  };

  const fire = (name: string, args: unknown[]) => {
    const entry = events.get(name);
    if (!entry) return;
    for (const [listener, filter] of [...entry.listeners]) {
      if (filter !== undefined && entry.matches && !entry.matches(filter, args))
        continue;
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  };

  // ---- Installing namespaces ---------------------------------------------------

  const targets = browserNamespace ? [chrome, browserNamespace] : [chrome];
  /** Add members to a namespace, replacing Electron's stubs of the same name. */
  const extend = (namespace: string, members: Bag) => {
    for (const target of targets) {
      let object = target[namespace] as Bag | undefined;
      if (!object || typeof object !== "object") {
        object = {};
        try {
          Object.defineProperty(target, namespace, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: object,
          });
        } catch {
          continue;
        }
      }
      for (const [key, value] of Object.entries(members)) {
        try {
          Object.defineProperty(object, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
          });
        } catch {
          // A frozen native member stays.
        }
      }
    }
  };
  const enumOf = (...values: string[]) =>
    Object.freeze(
      Object.fromEntries(
        values.map((value) => [
          value
            .replace(/[A-Z]/g, (c) => `_${c}`)
            .replace(/-/g, "_")
            .toUpperCase(),
          value,
        ]),
      ),
    );
  const methods = (namespace: string, names: string[]) =>
    Object.fromEntries(
      names.map((name) => [name, method(`${namespace}.${name}`)]),
    );
  const eventsOf = (
    namespace: string,
    names: string[],
    matches?: EventEntry["matches"],
  ) =>
    Object.fromEntries(
      names.map((name) => [name, event(`${namespace}.${name}`, matches)]),
    );

  // ---- tabs and windows ----------------------------------------------------------

  extend("tabs", {
    ...methods("tabs", [
      "get",
      "getCurrent",
      "query",
      "create",
      "update",
      "remove",
      "reload",
      "duplicate",
      "goBack",
      "goForward",
      "highlight",
      "move",
      "discard",
      "detectLanguage",
      "group",
      "ungroup",
    ]),
    captureVisibleTab: method("tabs.captureVisibleTab", (args) =>
      typeof args[0] === "object" ? [null, args[0]] : args,
    ),
    ...eventsOf("tabs", [
      "onCreated",
      "onUpdated",
      "onActivated",
      "onRemoved",
      "onMoved",
      "onHighlighted",
      "onAttached",
      "onDetached",
      "onReplaced",
    ]),
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
  });
  if (manifestVersion === 2)
    extend("tabs", {
      getSelected: method("tabs.getSelected"),
      getAllInWindow: method("tabs.getAllInWindow"),
    });

  extend("windows", {
    ...methods("windows", [
      "get",
      "getCurrent",
      "getLastFocused",
      "getAll",
      "create",
      "update",
      "remove",
    ]),
    ...eventsOf("windows", [
      "onCreated",
      "onRemoved",
      "onFocusChanged",
      "onBoundsChanged",
    ]),
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    WindowType: enumOf("normal", "popup", "panel", "app", "devtools"),
    WindowState: enumOf(
      "normal",
      "minimized",
      "maximized",
      "fullscreen",
      "locked-fullscreen",
    ),
    CreateType: enumOf("normal", "popup", "panel"),
  });

  // ---- Toolbar action --------------------------------------------------------------

  const imageDataOf = (value: unknown): Bag | null => {
    if (!value || typeof value !== "object") return null;
    const image = value as Bag;
    if (
      typeof image.width !== "number" ||
      typeof image.height !== "number" ||
      !ArrayBuffer.isView(image.data)
    )
      return null;
    return {
      width: image.width,
      height: image.height,
      data: new Uint8Array(
        (image.data as Uint8ClampedArray).buffer.slice(
          (image.data as Uint8ClampedArray).byteOffset,
          (image.data as Uint8ClampedArray).byteOffset +
            (image.data as Uint8ClampedArray).byteLength,
        ),
      ),
    };
  };
  // ImageData does not cross to main as itself: send its pixels.
  const prepareIcon = (args: unknown[]) => {
    const details = { ...((args[0] as Bag | undefined) ?? {}) };
    const imageData = details.imageData;
    if (imageData) {
      const single = imageDataOf(imageData);
      if (single) details.imageData = { [String(single.width)]: single };
      else if (typeof imageData === "object")
        details.imageData = Object.fromEntries(
          Object.entries(imageData as Bag).flatMap(([size, image]) => {
            const converted = imageDataOf(image);
            return converted ? [[size, converted]] : [];
          }),
        );
    }
    // Relative icon paths resolve against the calling page or worker
    // script, as in Chrome ("../icons/x.png" from background/index.js).
    const resolve = (path: unknown) =>
      typeof path === "string" && globalThis.location
        ? new URL(path, globalThis.location.href).href
        : path;
    if (typeof details.path === "string") details.path = resolve(details.path);
    else if (details.path && typeof details.path === "object")
      details.path = Object.fromEntries(
        Object.entries(details.path as Bag).map(([size, path]) => [
          size,
          resolve(path),
        ]),
      );
    return [details, ...args.slice(1)];
  };
  const actionMembers = (namespace: string): Bag => ({
    ...methods(namespace, [
      "setTitle",
      "getTitle",
      "setPopup",
      "getPopup",
      "setBadgeText",
      "getBadgeText",
      "setBadgeBackgroundColor",
      "getBadgeBackgroundColor",
      "setBadgeTextColor",
      "getBadgeTextColor",
      "enable",
      "disable",
      "isEnabled",
      "getUserSettings",
      "openPopup",
    ]),
    setIcon: method(`${namespace}.setIcon`, prepareIcon),
    onClicked: event(`${namespace}.onClicked`),
    onUserSettingsChanged: event(`${namespace}.onUserSettingsChanged`),
  });
  if (manifest.action) extend("action", actionMembers("action"));
  if (manifest.browser_action)
    extend("browserAction", actionMembers("browserAction"));
  if (manifest.page_action)
    extend("pageAction", {
      ...actionMembers("pageAction"),
      show: method("pageAction.enable"),
      hide: method("pageAction.disable"),
    });

  // ---- Permissions ------------------------------------------------------------------

  extend("permissions", {
    ...methods("permissions", ["getAll", "contains", "request", "remove"]),
    addHostAccessRequest: method("permissions.addHostAccessRequest"),
    removeHostAccessRequest: method("permissions.removeHostAccessRequest"),
    onAdded: event("permissions.onAdded"),
    onRemoved: event("permissions.onRemoved"),
  });

  // ---- Commands -----------------------------------------------------------------------

  extend("commands", {
    getAll: method("commands.getAll"),
    onCommand: event("commands.onCommand"),
  });

  // ---- Runtime ------------------------------------------------------------------------

  interface NativePort {
    port: Bag;
    onMessage: ReturnType<typeof localEvent>;
    onDisconnect: ReturnType<typeof localEvent>;
    connected: boolean;
  }
  const nativePorts = new Map<string, NativePort>();
  let nextPort = 0;
  const connectNative = (application: unknown) => {
    if (typeof application !== "string")
      throw new TypeError("Native application name must be a string.");
    const id = `${Date.now().toString(36)}-${nextPort++}`;
    const onMessage = localEvent();
    const onDisconnect = localEvent();
    const entry: NativePort = {
      port: {},
      onMessage,
      onDisconnect,
      connected: true,
    };
    entry.port = {
      name: application,
      onMessage,
      onDisconnect,
      postMessage(message: unknown) {
        if (!entry.connected)
          throw new Error("Attempting to use a disconnected port object");
        host.send("native-post", [id, plain(message)]);
      },
      disconnect() {
        if (!entry.connected) return;
        entry.connected = false;
        nativePorts.delete(id);
        host.send("native-disconnect", [id]);
      },
    };
    nativePorts.set(id, entry);
    host.send("native-connect", [id, application]);
    return entry.port;
  };
  extend("runtime", {
    openOptionsPage: method("runtime.openOptionsPage"),
    setUninstallURL: method("runtime.setUninstallURL"),
    getContexts: method("runtime.getContexts"),
    requestUpdateCheck: method("runtime.requestUpdateCheck"),
    sendNativeMessage: method("runtime.sendNativeMessage"),
    connectNative,
  });
  extend("management", {
    uninstallSelf: method("management.uninstallSelf"),
  });

  // Work never grants file URL or incognito access to extensions.
  const answer =
    (value: unknown) =>
    (...input: unknown[]) => {
      const callback = input.find((arg) => typeof arg === "function") as
        | Fn
        | undefined;
      if (callback) {
        callback(value);
        return undefined;
      }
      return Promise.resolve(value);
    };
  extend("extension", {
    isAllowedFileSchemeAccess: answer(false),
    isAllowedIncognitoAccess: answer(false),
  });

  // ---- storage.sync -----------------------------------------------------------------------

  const storage = chrome.storage as Bag | undefined;
  if (storage && permissions.has("storage")) {
    const syncChanged = event("storage.sync.onChanged");
    const area = {
      ...methods("storage.sync", [
        "get",
        "set",
        "remove",
        "clear",
        "getBytesInUse",
        "getKeys",
        "setAccessLevel",
      ]),
      onChanged: syncChanged,
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
      MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
    };
    // storage.onChanged reports every area; sync changes come from main.
    const native = storage.onChanged as
      | { addListener: Fn; removeListener: Fn; hasListener: Fn }
      | undefined;
    const wrapped = new Map<Fn, Fn>();
    const onChanged = {
      addListener(listener: unknown) {
        if (typeof listener !== "function")
          throw new TypeError("The listener must be a function.");
        if (wrapped.has(listener as Fn)) return;
        const sync = (changes: unknown) => (listener as Fn)(changes, "sync");
        wrapped.set(listener as Fn, sync);
        native?.addListener(listener);
        syncChanged.addListener(sync);
      },
      removeListener(listener: unknown) {
        const sync = wrapped.get(listener as Fn);
        if (!sync) return;
        wrapped.delete(listener as Fn);
        native?.removeListener(listener);
        syncChanged.removeListener(sync);
      },
      hasListener: (listener: unknown) => wrapped.has(listener as Fn),
      hasListeners: () => wrapped.size > 0,
    };
    for (const target of targets) {
      const object = target.storage as Bag | undefined;
      if (!object) continue;
      for (const [key, value] of [
        ["sync", area],
        ["onChanged", onChanged],
      ] as const) {
        try {
          Object.defineProperty(object, key, {
            configurable: true,
            enumerable: true,
            value,
          });
        } catch {
          // keep Electron's
        }
      }
    }
  }

  // ---- APIs behind a permission -------------------------------------------------------------

  const installers: Record<string, () => void> = {
    contextMenus: () => {
      const clicks = new Map<string, Fn>();
      let nextId = 1;
      const onClicked = event("contextMenus.onClicked");
      // MV2 `onclick` handlers live here; main only knows ids.
      onClicked.addListener((info: unknown, tab: unknown) => {
        const id = String((info as Bag | undefined)?.menuItemId ?? "");
        clicks.get(id)?.(info, tab);
      });
      const takeClick = (id: string, properties: Bag) => {
        if (typeof properties.onclick === "function")
          clicks.set(id, properties.onclick as Fn);
      };
      const call = method("contextMenus.create");
      extend("contextMenus", {
        create(properties: unknown, callback?: unknown) {
          const props = { ...((properties as Bag | undefined) ?? {}) };
          const id =
            typeof props.id === "string" || typeof props.id === "number"
              ? props.id
              : nextId++;
          // Kept as given: onClicked names a numeric id as a number.
          props.id = id;
          takeClick(String(id), props);
          call(props, typeof callback === "function" ? callback : () => {});
          return id;
        },
        update(id: unknown, properties: unknown, callback?: unknown) {
          takeClick(String(id), (properties as Bag | undefined) ?? {});
          return (method("contextMenus.update") as Fn)(
            String(id),
            properties,
            ...(typeof callback === "function" ? [callback] : []),
          );
        },
        remove(id: unknown, callback?: unknown) {
          clicks.delete(String(id));
          return (method("contextMenus.remove") as Fn)(
            String(id),
            ...(typeof callback === "function" ? [callback] : []),
          );
        },
        removeAll(callback?: unknown) {
          clicks.clear();
          return (method("contextMenus.removeAll") as Fn)(
            ...(typeof callback === "function" ? [callback] : []),
          );
        },
        onClicked,
        ACTION_MENU_TOP_LEVEL_LIMIT: 6,
        ContextType: enumOf(
          "all",
          "page",
          "frame",
          "selection",
          "link",
          "editable",
          "image",
          "video",
          "audio",
          "launcher",
          "browser_action",
          "page_action",
          "action",
        ),
        ItemType: enumOf("normal", "checkbox", "radio", "separator"),
      });
    },
    sidePanel: () =>
      extend("sidePanel", {
        ...methods("sidePanel", [
          "setOptions",
          "getOptions",
          "setPanelBehavior",
          "getPanelBehavior",
          "open",
          "close",
          "getLayout",
        ]),
        ...eventsOf("sidePanel", ["onOpened", "onClosed"]),
        Side: enumOf("left", "right"),
      }),
    debugger: () =>
      extend("debugger", {
        ...methods("debugger", [
          "attach",
          "detach",
          "sendCommand",
          "getTargets",
        ]),
        ...eventsOf("debugger", ["onEvent", "onDetach"]),
        DetachReason: Object.freeze({
          CANCELED_BY_USER: "canceled_by_user",
          TARGET_CLOSED: "target_closed",
        }),
        TargetInfoType: enumOf("page", "background_page", "worker", "other"),
      }),
    tabGroups: () =>
      extend("tabGroups", {
        ...methods("tabGroups", ["get", "query", "update", "move"]),
        ...eventsOf("tabGroups", [
          "onCreated",
          "onUpdated",
          "onRemoved",
          "onMoved",
        ]),
        TAB_GROUP_ID_NONE: -1,
        Color: enumOf(
          "grey",
          "blue",
          "red",
          "yellow",
          "green",
          "pink",
          "purple",
          "cyan",
          "orange",
        ),
      }),
    webNavigation: () =>
      extend("webNavigation", {
        ...methods("webNavigation", ["getFrame", "getAllFrames"]),
        ...eventsOf(
          "webNavigation",
          [
            "onBeforeNavigate",
            "onCommitted",
            "onDOMContentLoaded",
            "onCompleted",
            "onErrorOccurred",
            "onCreatedNavigationTarget",
            "onReferenceFragmentUpdated",
            "onTabReplaced",
            "onHistoryStateUpdated",
          ],
          navigationFilter,
        ),
        TransitionType: enumOf(
          "link",
          "typed",
          "auto_bookmark",
          "auto_subframe",
          "manual_subframe",
          "generated",
          "start_page",
          "form_submit",
          "reload",
          "keyword",
          "keyword_generated",
        ),
      }),
    notifications: () =>
      extend("notifications", {
        ...methods("notifications", [
          "create",
          "update",
          "clear",
          "getAll",
          "getPermissionLevel",
        ]),
        ...eventsOf("notifications", [
          "onClosed",
          "onClicked",
          "onButtonClicked",
          "onPermissionLevelChanged",
          "onShowSettings",
        ]),
        TemplateType: enumOf("basic", "image", "list", "progress"),
        PermissionLevel: enumOf("granted", "denied"),
      }),
    downloads: () =>
      extend("downloads", {
        ...methods("downloads", [
          "download",
          "search",
          "pause",
          "resume",
          "cancel",
          "erase",
          "show",
          "showDefaultFolder",
          "open",
          "removeFile",
          "getFileIcon",
          "setUiOptions",
          "setShelfEnabled",
          "acceptDanger",
        ]),
        ...eventsOf("downloads", ["onCreated", "onChanged", "onErased"]),
        State: enumOf("in_progress", "interrupted", "complete"),
      }),
    identity: () =>
      extend("identity", {
        ...methods("identity", [
          "launchWebAuthFlow",
          "getAuthToken",
          "getProfileUserInfo",
          "removeCachedAuthToken",
          "clearAllCachedAuthTokens",
          "getAccounts",
        ]),
        getRedirectURL: (path?: unknown) =>
          `https://${runtime.id}.chromiumapp.org/${typeof path === "string" ? path.replace(/^\//, "") : ""}`,
        onSignInChanged: event("identity.onSignInChanged"),
      }),
    bookmarks: () =>
      extend("bookmarks", {
        ...methods("bookmarks", [
          "get",
          "getChildren",
          "getRecent",
          "getTree",
          "getSubTree",
          "search",
          "create",
          "move",
          "update",
          "remove",
          "removeTree",
        ]),
        ...eventsOf("bookmarks", [
          "onCreated",
          "onRemoved",
          "onChanged",
          "onMoved",
          "onChildrenReordered",
          "onImportBegan",
          "onImportEnded",
        ]),
      }),
    history: () =>
      extend("history", {
        ...methods("history", [
          "search",
          "getVisits",
          "addUrl",
          "deleteUrl",
          "deleteRange",
          "deleteAll",
        ]),
        ...eventsOf("history", ["onVisited", "onVisitRemoved"]),
      }),
    topSites: () => extend("topSites", { get: method("topSites.get") }),
    sessions: () =>
      extend("sessions", {
        ...methods("sessions", ["getRecentlyClosed", "getDevices", "restore"]),
        onChanged: event("sessions.onChanged"),
        MAX_SESSION_RESULTS: 25,
      }),
    fontSettings: () =>
      extend("fontSettings", {
        ...methods("fontSettings", [
          "getFontList",
          "getFont",
          "setFont",
          "clearFont",
          "getDefaultFontSize",
          "setDefaultFontSize",
          "clearDefaultFontSize",
          "getDefaultFixedFontSize",
          "setDefaultFixedFontSize",
          "clearDefaultFixedFontSize",
          "getMinimumFontSize",
          "setMinimumFontSize",
          "clearMinimumFontSize",
        ]),
        ...eventsOf("fontSettings", [
          "onFontChanged",
          "onDefaultFontSizeChanged",
          "onDefaultFixedFontSizeChanged",
          "onMinimumFontSizeChanged",
        ]),
      }),
    cookies: () =>
      extend("cookies", {
        ...methods("cookies", [
          "get",
          "getAll",
          "set",
          "remove",
          "getAllCookieStores",
        ]),
        onChanged: event("cookies.onChanged"),
        SameSiteStatus: enumOf(
          "no_restriction",
          "lax",
          "strict",
          "unspecified",
        ),
        OnChangedCause: enumOf(
          "evicted",
          "expired",
          "explicit",
          "expired_overwrite",
          "overwrite",
        ),
      }),
  };
  const installed = new Set<string>();
  const install = (permission: string) => {
    const installer = installers[permission];
    if (!installer || installed.has(permission)) return;
    installed.add(permission);
    installer();
  };
  for (const permission of permissions) install(permission);

  // ---- Main's messages to this context -----------------------------------------------------

  host.onEvent((name, args) => {
    if (name === "__native.message" || name === "__native.disconnect") {
      const port = nativePorts.get(String(args[0]));
      if (!port) return;
      if (name === "__native.message") {
        port.onMessage.fire(args[1], port.port);
        return;
      }
      port.connected = false;
      nativePorts.delete(String(args[0]));
      const error = typeof args[1] === "string" ? args[1] : null;
      if (error) withLastError(error, () => port.onDisconnect.fire(port.port));
      else port.onDisconnect.fire(port.port);
      return;
    }
    if (name === "__permissions.granted") {
      for (const permission of strings(args[0]))
        if (optional.has(permission)) install(permission);
      return;
    }
    fire(name, args);
  });
}
