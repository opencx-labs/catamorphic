import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  type Session,
  session,
  systemPreferences,
  type WebContents,
} from "electron";
import { BookmarksStore } from "./bookmarks.js";
import { BrowserHistoryStore } from "./browser-history.js";
import {
  listImportableBrowsers,
  readBrowserBookmarks,
} from "./browser-import/index.js";
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

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
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
    contents.on("before-input-event", (_e, input) => {
      if (input.type !== "keyDown" || !input.meta) return;
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
    "catamorphic:vault-save",
    (
      _event,
      input: {
        profileId: string;
        origin: string;
        username: string;
        password: string;
      },
    ) =>
      vault.save(input.profileId, {
        origin: input.origin,
        username: input.username,
        password: input.password,
      }),
  );
  ipcMain.handle(
    "catamorphic:vault-remove",
    (_event, input: { profileId: string; id: string }) =>
      vault.remove(input.profileId, input.id),
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
      input: { projectId: string; profileId: string; label: string },
    ) => {
      const folder = bookmarks.addFolder(input.projectId, input.label);
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
        bookmarksImported += bookmarks.importPinned(
          targetProfileId,
          imported.bookmarks,
        );
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

  return {
    history,
    dispose: () => {
      history.dispose();
    },
  };
}
