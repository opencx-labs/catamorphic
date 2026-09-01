import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type Session,
  session,
  systemPreferences,
  type WebContents,
  webContents,
} from "electron";
import { BookmarksStore } from "./bookmarks.js";
import { BrowserHistoryStore } from "./browser-history.js";
import {
  listImportableBrowsers,
  readBrowserBookmarks,
} from "./browser-import/index.js";
import { parsePasswordCsv } from "./browser-import/password-csv.js";
import { PasswordVault } from "./browser-vault.js";
import type { WindowProfileRegistry } from "./index.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { DEFAULT_SIDEBAR_FILE } from "./sidebar-config.js";

/**
 * Browser support for workspace tabs. Pages render in `<webview>` tags in
 * the renderer (they composite into the page, so app overlays like the
 * autocomplete dropdown and chat dock stack correctly); this module owns
 * everything per-profile and main-process-only:
 *  - persistent session partitions (`persist:profile-<id>`) with a clean
 *    Chrome UA so Google sign-in works and survives restarts per profile,
 *  - popup/new-window requests turned into "open new tab" events,
 *  - Cmd+L observed inside page content and forwarded to the address bar,
 *  - browsing history (address-bar autocomplete),
 *  - the KDBX password vault gated by device auth,
 *  - unpacked Chrome extensions loaded per profile.
 */

// Partition → in-flight/settled prepare. A Promise map (not a Set of
// done flags): concurrent callers share one prepare and actually await
// it, and a failed prepare is retried on the next call instead of being
// permanently marked done while half-applied.
const preparedSessions = new Map<string, Promise<void>>();

/**
 * Chrome's client-hint brand list, derived from the session UA. Google's
 * supported-browser gate reads these; Electron would otherwise advertise
 * only "Chromium". The UA string itself is already Chrome-clean app-wide
 * (see `app.userAgentFallback` in main/index.ts).
 */
function chromeBrands(ua: string): { brands: string; fullVersionList: string } {
  const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "150";
  const full = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? `${major}.0.0.0`;
  return {
    brands: `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not;A=Brand";v="8"`,
    fullVersionList: `"Google Chrome";v="${full}", "Chromium";v="${full}", "Not;A=Brand";v="8.0.0.0"`,
  };
}

export function partitionFor(profileId: string): string {
  return `persist:profile-${profileId}`;
}

function extensionsDir(profilesDir: string, profileId: string): string {
  return path.join(profilesDir, profileId, "extensions");
}

function prepareProfileSession(
  profilesDir: string,
  profileId: string,
): Promise<void> {
  const partition = partitionFor(profileId);
  const existing = preparedSessions.get(partition);
  if (existing) return existing;
  const prepare = doPrepareProfileSession(profilesDir, partition, profileId);
  preparedSessions.set(partition, prepare);
  prepare.catch(() => preparedSessions.delete(partition));
  return prepare;
}

async function doPrepareProfileSession(
  profilesDir: string,
  partition: string,
  profileId: string,
): Promise<void> {
  const ses = session.fromPartition(partition);
  const { brands, fullVersionList } = chromeBrands(ses.getUserAgent());

  // Header layer: Chromium sends Sec-CH-UA built from its own brand list,
  // which no setUserAgent call covers.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === "sec-ch-ua") headers[name] = brands;
      else if (lower === "sec-ch-ua-full-version-list") {
        headers[name] = fullVersionList;
      }
    }
    callback({ requestHeaders: headers });
  });

  // Chrome-like permission behavior without prompt UI yet: allow the
  // low-risk requests sites commonly need, deny device-level ones.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      ["clipboard-sanitized-write", "fullscreen", "notifications"].includes(
        permission,
      ),
    );
  });

  // Unpacked Chrome extensions: drop a folder under the profile's
  // extensions dir and it loads on next launch (content scripts, e.g.
  // password-manager extensions' fill logic, work in webviews).
  const dir = extensionsDir(profilesDir, profileId);
  if (fs.existsSync(dir)) {
    // `session.extensions` on modern Electron; fall back to the older
    // session-level API.
    const extensionHost =
      (ses as { extensions?: { loadExtension: Session["loadExtension"] } })
        .extensions ?? ses;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const extPath = path.join(dir, entry.name);
      if (!fs.existsSync(path.join(extPath, "manifest.json"))) continue;
      try {
        await extensionHost.loadExtension(extPath);
        console.log(`[desktop] loaded extension ${entry.name} (${profileId})`);
      } catch (cause) {
        console.warn(
          `[desktop] failed to load extension ${entry.name}:`,
          cause,
        );
      }
    }
  }
}

export interface BrowserSupport {
  history: BrowserHistoryStore;
  dispose: () => void;
}

export function registerBrowserSupport(
  profiles: ProfilesStore,
  /** Shared with the config agent so chat edits and IPC hit one store set. */
  profileConfig: ProfileConfigManager,
  windows: WindowProfileRegistry,
  /** Project root lookup for layered sidebar resolution (embedded server). */
  projectRootFor: (projectId: string) => Promise<string | null>,
): BrowserSupport {
  const userData = app.getPath("userData");
  const profilesDir = path.join(userData, "profiles");
  const history = new BrowserHistoryStore(profilesDir);
  const vault = new PasswordVault(profilesDir);
  const bookmarks = new BookmarksStore(path.join(userData, "bookmarks.json"));
  const appCommandListeners = new Map<
    BrowserWindow,
    (event: Electron.Event, command: string) => void
  >();

  const attachBrowserCommands = (
    _event: Electron.Event | null,
    window: BrowserWindow,
  ) => {
    const listener = (_commandEvent: Electron.Event, command: string) => {
      const direction =
        command === "browser-backward"
          ? "back"
          : command === "browser-forward"
            ? "forward"
            : null;
      if (!direction) return;
      const focused = webContents.getFocusedWebContents();
      const guestId =
        focused?.getType() === "webview" &&
        focused.hostWebContents === window.webContents
          ? focused.id
          : null;
      window.webContents.send("catamorphic:browser-navigate", {
        webContentsId: guestId,
        direction,
      });
    };
    appCommandListeners.set(window, listener);
    window.on("app-command", listener);
    window.once("closed", () => appCommandListeners.delete(window));
  };
  app.on("browser-window-created", attachBrowserCommands);
  for (const window of BrowserWindow.getAllWindows()) {
    attachBrowserCommands(null, window);
  }

  interface PendingCredential {
    id: string;
    guestId: number;
    hostId: number;
    profileId: string;
    origin: string;
    username: string;
    password: string;
    expiresAt: number;
  }

  const pendingCredentials = new Map<string, PendingCredential>();
  const focusedLoginForms = new Map<number, string>();
  const pendingLifetimeMs = 2 * 60 * 1000;

  const httpOrigin = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.origin
        : null;
    } catch {
      return null;
    }
  };

  const guestContext = (
    guest: WebContents,
  ): { host: WebContents; profileId: string; origin: string } | null => {
    if (guest.getType() !== "webview") return null;
    const host = guest.hostWebContents;
    const origin = httpOrigin(guest.getURL());
    if (!host || host.isDestroyed() || !origin) return null;
    return { host, profileId: windows.profileFor(host), origin };
  };

  const rendererOwnsGuest = (
    renderer: WebContents,
    guestId: number,
    profileId: string,
  ): WebContents | null => {
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents !== renderer) {
      return null;
    }
    if (windows.profileFor(renderer) !== profileId) return null;
    return guest;
  };

  const onLoginForms = async (
    event: Electron.IpcMainEvent,
    payload: { origin?: string; forms?: Array<{ id?: string }> },
  ) => {
    const context = guestContext(event.sender);
    if (!context || payload.origin !== context.origin) return;
    const credentials = await vault.list(context.profileId, context.origin);
    if (
      credentials.length === 0 ||
      event.sender.isDestroyed() ||
      guestContext(event.sender)?.origin !== context.origin
    ) {
      return;
    }
    const formId = payload.forms?.find((form) => form.id)?.id;
    context.host.send("catamorphic:browser-credential-fill-offer", {
      guestId: event.sender.id,
      formId,
      origin: context.origin,
      credentials,
    });
  };

  const onSubmittedCredentials = (
    event: Electron.IpcMainEvent,
    payload: {
      origin?: string;
      username?: string;
      password?: string;
    },
  ) => {
    const context = guestContext(event.sender);
    if (
      !context ||
      payload.origin !== context.origin ||
      typeof payload.username !== "string" ||
      typeof payload.password !== "string" ||
      payload.password.length === 0
    ) {
      return;
    }
    const id = randomUUID();
    const pending: PendingCredential = {
      id,
      guestId: event.sender.id,
      hostId: context.host.id,
      profileId: context.profileId,
      origin: context.origin,
      username: payload.username,
      password: payload.password,
      expiresAt: Date.now() + pendingLifetimeMs,
    };
    pendingCredentials.set(id, pending);
    context.host.send("catamorphic:browser-credential-save-offer", {
      pendingId: id,
      guestId: event.sender.id,
      origin: context.origin,
      username: payload.username,
    });
    setTimeout(() => pendingCredentials.delete(id), pendingLifetimeMs).unref();
  };

  const onLoginFormFocused = (
    event: Electron.IpcMainEvent,
    payload: { origin?: string; formId?: string },
  ) => {
    const context = guestContext(event.sender);
    if (
      !context ||
      payload.origin !== context.origin ||
      typeof payload.formId !== "string"
    ) {
      return;
    }
    focusedLoginForms.set(event.sender.id, payload.formId);
  };

  ipcMain.on("catamorphic:browser-login-forms", onLoginForms);
  ipcMain.on(
    "catamorphic:browser-credentials-submitted",
    onSubmittedCredentials,
  );
  ipcMain.on("catamorphic:browser-login-form-focused", onLoginFormFocused);

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  const vaultChanged = (profileId: string) => {
    for (const window of windows.windowsFor(profileId)) {
      window.webContents.send("catamorphic:vault-changed", { profileId });
    }
  };

  // Guest page wiring. Webview guests are created by Chromium — this event
  // is the only place to attach main-process behavior to them.
  app.on("web-contents-created", (_event, contents: WebContents) => {
    if (contents.getType() !== "webview") return;

    // target=_blank / window.open → new workspace browser tab.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) {
        broadcast("catamorphic:browser-open-url", { url });
      }
      return { action: "deny" };
    });

    // App shortcuts (Cmd+L, Cmd+T, …) pressed while focus is inside page
    // content never reach the renderer's window listeners — observe guest
    // keys and forward Cmd-combos for the renderer to match against its
    // (user-configurable) bindings. Cmd+L is special-cased to the address
    // bar of the owning tab.
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const browserDirection =
        input.key === "BrowserBack"
          ? "back"
          : input.key === "BrowserForward"
            ? "forward"
            : null;
      if (
        browserDirection &&
        !input.meta &&
        !input.control &&
        !input.alt &&
        !input.shift
      ) {
        event.preventDefault();
        contents.hostWebContents?.send("catamorphic:browser-navigate", {
          webContentsId: contents.id,
          direction: browserDirection,
        });
        return;
      }
      if (!input.meta) return;
      if (
        !input.control &&
        !input.alt &&
        !input.shift &&
        input.key.toLowerCase() === "l"
      ) {
        broadcast("catamorphic:browser-focus-address", {
          webContentsId: contents.id,
        });
        return;
      }
      broadcast("catamorphic:browser-guest-key", {
        webContentsId: contents.id,
        key: input.key,
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
      });
    });

    contents.on("context-menu", (_event, params) => {
      if (params.formControlType !== "input-password") return;
      const context = guestContext(contents);
      if (!context) return;
      void vault.list(context.profileId, context.origin).then((credentials) => {
        if (contents.isDestroyed()) return;
        const formId = focusedLoginForms.get(contents.id);
        const template: Electron.MenuItemConstructorOptions[] = credentials.map(
          (credential) => ({
            label: credential.username || "Saved password",
            click: () => {
              void vault
                .reveal(context.profileId, credential.id)
                .then((revealed) => {
                  if (!revealed || contents.isDestroyed()) return;
                  if (httpOrigin(contents.getURL()) !== context.origin) return;
                  contents.send("catamorphic:fill-credentials", {
                    formId,
                    username: revealed.username,
                    password: revealed.password,
                  });
                });
            },
          }),
        );
        if (template.length > 0) template.push({ type: "separator" });
        template.push({
          label: "Suggest strong password",
          click: () => {
            if (
              contents.isDestroyed() ||
              httpOrigin(contents.getURL()) !== context.origin
            ) {
              return;
            }
            contents.send("catamorphic:fill-credentials", {
              formId,
              username: "",
              password: `${randomUUID().replaceAll("-", "")}!aA1`,
            });
          },
        });
        Menu.buildFromTemplate(template).popup();
      });
    });
    contents.once("destroyed", () => focusedLoginForms.delete(contents.id));
  });

  ipcMain.handle(
    "catamorphic:browser-prepare-profile",
    async (_event, profileId: string) => {
      await prepareProfileSession(profilesDir, profileId);
      return partitionFor(profileId);
    },
  );

  ipcMain.handle(
    "catamorphic:browser-history-record",
    (_event, input: { profileId: string; url: string; title: string }) => {
      history.record(input.profileId, input.url, input.title);
    },
  );

  ipcMain.handle(
    "catamorphic:browser-history-retitle",
    (_event, input: { profileId: string; url: string; title: string }) => {
      history.retitle(input.profileId, input.url, input.title);
    },
  );
  ipcMain.handle(
    "catamorphic:browser-history-favicon",
    (_event, input: { profileId: string; url: string; faviconUrl: string }) => {
      history.setFavicon(input.profileId, input.url, input.faviconUrl);
    },
  );

  ipcMain.handle(
    "catamorphic:browser-history-recent",
    (_event, input: { profileId: string; limit?: number }) =>
      history.recent(input.profileId, input.limit ?? 150),
  );

  ipcMain.handle(
    "catamorphic:browser-suggest",
    (_event, input: { profileId: string; query: string }) => ({
      matches: history.suggest(input.profileId, input.query),
      inline: history.inlineMatch(input.profileId, input.query),
    }),
  );

  // --- profiles ---
  ipcMain.handle("catamorphic:profiles-list", () => profiles.list());
  ipcMain.handle("catamorphic:profiles-create", (_event, name: string) => {
    const profile = profiles.create(name);
    broadcast("catamorphic:profiles-changed", profiles.list());
    return profile;
  });
  ipcMain.handle(
    "catamorphic:profiles-update",
    (
      _event,
      id: string,
      patch: { name?: string; color?: string; defaultProjectId?: string },
    ) => {
      const profile = profiles.update(id, patch);
      broadcast("catamorphic:profiles-changed", profiles.list());
      return profile;
    },
  );
  ipcMain.handle("catamorphic:profiles-set-default", (_event, id: string) => {
    profiles.setDefaultProfile(id);
    broadcast("catamorphic:profiles-changed", profiles.list());
  });
  ipcMain.handle("catamorphic:profiles-remove", (_event, id: string) => {
    const removed = profiles.remove(id);
    if (removed) broadcast("catamorphic:profiles-changed", profiles.list());
    return removed;
  });
  ipcMain.handle(
    "catamorphic:profiles-claim-project",
    (_event, profileId: string, projectId: string) => {
      profiles.claimProject(profileId, projectId);
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );
  ipcMain.handle(
    "catamorphic:profiles-for-project",
    (_event, projectId: string) => profiles.profileForProject(projectId),
  );
  ipcMain.handle(
    "catamorphic:profiles-release-project",
    (_event, projectId: string) => {
      profiles.releaseProject(projectId);
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );

  // --- passwords ---
  ipcMain.handle(
    "catamorphic:vault-list",
    (_event, input: { profileId: string; origin?: string }) =>
      vault.list(input.profileId, input.origin),
  );
  ipcMain.handle(
    "catamorphic:vault-reveal",
    (_event, input: { profileId: string; id: string }) =>
      vault.reveal(input.profileId, input.id),
  );
  ipcMain.handle(
    "catamorphic:vault-update",
    async (
      _event,
      input: {
        profileId: string;
        id: string;
        origin: string;
        username: string;
        password?: string;
      },
    ) => {
      const updated = await vault.update(input.profileId, input.id, {
        origin: input.origin,
        username: input.username,
        password: input.password,
      });
      if (updated) vaultChanged(input.profileId);
      return updated;
    },
  );
  ipcMain.handle(
    "catamorphic:vault-save",
    async (
      _event,
      input: {
        profileId: string;
        origin: string;
        username: string;
        password: string;
      },
    ) => {
      const saved = await vault.save(input.profileId, {
        origin: input.origin,
        username: input.username,
        password: input.password,
      });
      vaultChanged(input.profileId);
      return saved;
    },
  );
  ipcMain.handle(
    "catamorphic:vault-copy-password",
    async (_event, input: { profileId: string; id: string }) => {
      const credential = await vault.reveal(input.profileId, input.id);
      if (!credential) return false;
      clipboard.writeText(credential.password);
      setTimeout(() => {
        if (clipboard.readText() === credential.password) clipboard.clear();
      }, 30_000).unref();
      return true;
    },
  );
  ipcMain.handle(
    "catamorphic:browser-credential-accept",
    async (event, input: { profileId: string; pendingId: string }) => {
      const pending = pendingCredentials.get(input.pendingId);
      pendingCredentials.delete(input.pendingId);
      if (
        !pending ||
        pending.expiresAt < Date.now() ||
        pending.profileId !== input.profileId ||
        pending.hostId !== event.sender.id ||
        httpOrigin(
          rendererOwnsGuest(
            event.sender,
            pending.guestId,
            input.profileId,
          )?.getURL() ?? "",
        ) !== pending.origin
      ) {
        return false;
      }
      await vault.save(input.profileId, pending);
      vaultChanged(input.profileId);
      return true;
    },
  );
  ipcMain.handle(
    "catamorphic:browser-credential-dismiss",
    (event, input: { pendingId: string }) => {
      const pending = pendingCredentials.get(input.pendingId);
      if (pending?.hostId === event.sender.id) {
        pendingCredentials.delete(input.pendingId);
      }
    },
  );
  ipcMain.handle(
    "catamorphic:browser-credential-fill",
    async (
      event,
      input: {
        profileId: string;
        guestId: number;
        credentialId: string;
        formId?: string;
        origin: string;
      },
    ) => {
      const guest = rendererOwnsGuest(
        event.sender,
        input.guestId,
        input.profileId,
      );
      if (!guest || httpOrigin(guest.getURL()) !== input.origin) {
        return "origin-changed" as const;
      }
      const credential = await vault.reveal(
        input.profileId,
        input.credentialId,
      );
      if (!credential || credential.origin !== input.origin) {
        return "cancelled" as const;
      }
      if (
        guest.isDestroyed() ||
        guest.hostWebContents !== event.sender ||
        windows.profileFor(event.sender) !== input.profileId ||
        httpOrigin(guest.getURL()) !== input.origin
      ) {
        return "origin-changed" as const;
      }
      guest.send("catamorphic:fill-credentials", {
        formId: input.formId,
        username: credential.username,
        password: credential.password,
      });
      return "filled" as const;
    },
  );
  ipcMain.handle(
    "catamorphic:vault-remove",
    async (_event, input: { profileId: string; id: string }) => {
      await vault.remove(input.profileId, input.id);
      vaultChanged(input.profileId);
    },
  );
  ipcMain.handle("catamorphic:device-auth-available", () =>
    process.platform === "darwin"
      ? systemPreferences.canPromptTouchID()
      : false,
  );

  // --- bookmarks ---
  const bookmarksChanged = (projectId: string, profileId: string) =>
    broadcast("catamorphic:bookmarks-changed", {
      projectId,
      project: bookmarks.forProject(projectId),
      profileId,
      pinned: bookmarks.pinned(profileId),
    });

  ipcMain.handle(
    "catamorphic:bookmarks-get",
    (_event, input: { projectId: string; profileId: string }) => ({
      project: bookmarks.forProject(input.projectId),
      pinned: bookmarks.pinned(input.profileId),
    }),
  );
  ipcMain.handle(
    "catamorphic:bookmarks-add",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        label: string;
        url: string;
        folderId?: string;
        faviconUrl?: string;
      },
    ) => {
      const bookmark = bookmarks.addBookmark(input.projectId, input);
      bookmarksChanged(input.projectId, input.profileId);
      return bookmark;
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-add-folder",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        label: string;
        parentId?: string;
      },
    ) => {
      const folder = bookmarks.addFolder(
        input.projectId,
        input.label,
        input.parentId,
      );
      bookmarksChanged(input.projectId, input.profileId);
      return folder;
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-update",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        id: string;
        label?: string;
        url?: string;
        folderId?: string | null;
      },
    ) => {
      bookmarks.update(input.projectId, input.id, input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-remove",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.remove(input.projectId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-pin",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.pin(input.projectId, input.profileId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-unpin",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.unpin(input.profileId, input.projectId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-rename",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        id: string;
        label: string;
      },
    ) => {
      bookmarks.rename(input.projectId, input.profileId, input.id, input.label);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-remove-pinned",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.removePinned(input.profileId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );

  // --- sidebar config (per sender profile) ---
  const sidebarFor = (event: Electron.IpcMainInvokeEvent) =>
    profileConfig.forProfile(windows.profileFor(event.sender)).sidebar;

  // Layered per project (ADR 0043): project-local override → project
  // `.catamorphic/sidebar.js` → profile `sidebar.js` → built-in default.
  // Without a projectId only the profile layer applies (boot, settings).
  // The `-file`/`-source`/`-reset` handlers below stay profile-scoped:
  // they back the Settings "edit sidebar.js" surface.
  ipcMain.handle(
    "catamorphic:sidebar-config-get",
    async (event, projectId?: string) => {
      const profileId = windows.profileFor(event.sender);
      if (!projectId) return profileConfig.resolveSidebar(profileId);
      return profileConfig.resolveSidebar(profileId, {
        id: projectId,
        rootPath: await projectRootFor(projectId),
      });
    },
  );
  ipcMain.handle(
    "catamorphic:sidebar-config-file",
    (event) => sidebarFor(event).file,
  );
  ipcMain.handle("catamorphic:sidebar-config-source", (event) =>
    sidebarFor(event).read(),
  );
  ipcMain.handle("catamorphic:sidebar-config-reset", (event) => {
    sidebarFor(event).write(DEFAULT_SIDEBAR_FILE);
  });
  // Change fan-out lives in main/index.ts (profileConfig.onSidebarChanged),
  // scoped to the owning profile's windows.

  // --- import from other browsers ---
  // Detection + parsing lives in ./browser-import (pure, per-browser).
  // Imported bookmarks land in a profile's pinned list; a source profile
  // can also become a brand-new Catamorphic profile.
  ipcMain.handle("catamorphic:browser-import-list", () =>
    listImportableBrowsers(),
  );

  ipcMain.handle(
    "catamorphic:browser-import-run",
    (
      event,
      input: {
        browserId: string;
        imports: Array<{
          sourceProfileId: string;
          sourceProfileName: string;
          target: "current" | "new-profile";
        }>;
      },
    ) => {
      const currentProfileId = windows.profileFor(event.sender);
      let bookmarksImported = 0;
      const profilesCreated: string[] = [];

      for (const item of input.imports) {
        const imported = readBrowserBookmarks(
          input.browserId,
          item.sourceProfileId,
        );
        let targetProfileId = currentProfileId;
        if (item.target === "new-profile") {
          const profile = profiles.create(item.sourceProfileName);
          profilesCreated.push(profile.id);
          targetProfileId = profile.id;
        }
        bookmarksImported += bookmarks.importPinned(targetProfileId, imported);
        if (targetProfileId === currentProfileId) {
          broadcast("catamorphic:bookmarks-changed", {
            projectId: null,
            project: null,
            profileId: targetProfileId,
            pinned: bookmarks.pinned(targetProfileId),
          });
        }
      }

      if (profilesCreated.length > 0) {
        broadcast("catamorphic:profiles-changed", profiles.list());
      }
      return { bookmarksImported, profilesCreated };
    },
  );

  ipcMain.handle("catamorphic:browser-import-passwords", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { imported: 0, cancelled: true };
    const picked = await dialog.showOpenDialog(window, {
      title: "Import passwords from Chrome or Firefox",
      properties: ["openFile"],
      filters: [{ name: "Password CSV", extensions: ["csv"] }],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return { imported: 0, cancelled: true };
    const profileId = windows.profileFor(event.sender);
    const imported = parsePasswordCsv(fs.readFileSync(file, "utf-8"));
    for (const credential of imported) {
      await vault.save(profileId, credential);
    }
    if (imported.length > 0) vaultChanged(profileId);
    return { imported: imported.length, cancelled: false };
  });

  return {
    history,
    dispose: () => {
      app.removeListener("browser-window-created", attachBrowserCommands);
      for (const [window, listener] of appCommandListeners) {
        if (!window.isDestroyed())
          window.removeListener("app-command", listener);
      }
      appCommandListeners.clear();
      ipcMain.removeListener("catamorphic:browser-login-forms", onLoginForms);
      ipcMain.removeListener(
        "catamorphic:browser-credentials-submitted",
        onSubmittedCredentials,
      );
      ipcMain.removeListener(
        "catamorphic:browser-login-form-focused",
        onLoginFormFocused,
      );
      pendingCredentials.clear();
      focusedLoginForms.clear();
      history.dispose();
    },
  };
}
