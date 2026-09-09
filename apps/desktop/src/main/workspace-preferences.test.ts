import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePrefs } from "../shared/app-prefs.js";
import { BookmarksStore } from "./bookmarks.js";
import { PrefsStore } from "./prefs.js";

const directories: string[] = [];
function tempFile(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-prefs-"));
  directories.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace preferences", () => {
  it("starts every profile without macros and keeps saved commands isolated", () => {
    const first = new PrefsStore(tempFile("prefs.json"));
    const second = new PrefsStore(tempFile("prefs.json"));
    expect(first.load().terminalMacros).toEqual([]);
    first.load().terminalMacros.push({
      id: "unsaved",
      name: "Unsaved",
      command: "pwd",
      shortcut: "",
    });
    expect(first.load().terminalMacros).toEqual([]);
    expect(second.load().terminalMacros).toEqual([]);
    expect(
      normalizePrefs({ gitTerminalCommand: "lazygit" }).terminalMacros,
    ).toEqual([]);
    const macro = {
      id: "serve",
      name: "Dev server",
      command: "bun run dev",
      shortcut: "Ctrl+Alt+D",
    };
    first.save({ terminalMacros: [macro] });
    expect(new PrefsStore(first.file).load().terminalMacros).toEqual([macro]);
    expect(second.load().terminalMacros).toEqual([]);
  });
  it("rejects malformed macros and keeps bare typing keys out of global shortcuts", () => {
    expect(
      normalizePrefs({
        terminalMacros: [
          null,
          { id: "bad" },
          { id: "empty", name: "Name", command: " " },
          { id: "ok", name: " Shell ", command: " pwd ", shortcut: "A" },
          { id: "ok", name: "Duplicate", command: "date", shortcut: "Alt+D" },
        ],
      }).terminalMacros,
    ).toEqual([{ id: "ok", name: "Shell", command: "pwd", shortcut: "" }]);
  });

  it("keeps existing profiles on top tabs and preserves unrelated preferences on a layout edit", () => {
    const file = tempFile("prefs.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        notificationSounds: false,
        lastProjectId: "project",
        custom: "keep",
      }),
    );
    const store = new PrefsStore(file);
    expect(store.load()).toMatchObject({
      tabPlacement: "top",
      tabFrame: false,
    });
    store.save({
      tabPlacement: "sidebar",
      headerPlacement: "sidebar",
      tabFrame: true,
      pinnedBookmarks: "list",
      linkOpenMode: "floating",
      previewLinksWithAlt: false,
      terminalMacros: [
        {
          id: "status",
          name: "Project status",
          command: "git status",
          shortcut: "Ctrl+Alt+G",
        },
      ],
      terminalAppearance: "ghostty",
    });
    expect(new PrefsStore(file).load()).toMatchObject({
      tabPlacement: "sidebar",
      headerPlacement: "sidebar",
      tabFrame: true,
      pinnedBookmarks: "list",
      linkOpenMode: "floating",
      previewLinksWithAlt: false,
      terminalMacros: [
        {
          id: "status",
          name: "Project status",
          command: "git status",
          shortcut: "Ctrl+Alt+G",
        },
      ],
      terminalAppearance: "ghostty",
      notificationSounds: false,
      lastProjectId: "project",
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).custom).toBe("keep");
    expect(
      normalizePrefs({
        tabPlacement: "garbage",
        tabFrame: "true",
        pinnedBookmarks: null,
      }),
    ).toMatchObject({
      tabPlacement: "top",
      tabFrame: false,
      pinnedBookmarks: "tiles",
    });
  });
});

describe("bookmark organization", () => {
  it("renames folders, moves bookmarks, and keeps them when their folder is removed", () => {
    const file = tempFile("bookmarks.json");
    const store = new BookmarksStore(file);
    const folder = store.addFolder("project", "Dev");
    const bookmark = store.addBookmark("project", {
      label: "Docs",
      url: "https://example.com",
    });
    store.update("project", bookmark.id, { folderId: folder.id });
    store.rename("project", "profile", folder.id, "Reference");
    expect(
      new BookmarksStore(file).forProject("project").folders[0]?.label,
    ).toBe("Reference");
    store.remove("project", folder.id);
    expect(new BookmarksStore(file).forProject("project")).toEqual({
      folders: [],
      bookmarks: [{ ...bookmark, folderId: undefined }],
    });
  });
  it("pins across projects without retaining a folder from another project", () => {
    const store = new BookmarksStore(tempFile("bookmarks.json"));
    const folder = store.addFolder("first", "Dev");
    const bookmark = store.addBookmark("first", {
      label: "Docs",
      url: "https://example.com",
      folderId: folder.id,
    });
    store.pin("first", "profile", bookmark.id);
    expect(store.forProject("first").bookmarks).toEqual([]);
    expect(store.pinned("profile").bookmarks[0]?.folderId).toBeUndefined();
    store.unpin("profile", "second", bookmark.id);
    expect(store.forProject("second").bookmarks[0]?.id).toBe(bookmark.id);
    expect(store.pinned("profile").bookmarks).toEqual([]);
  });
});

describe("bookmark drops", () => {
  it("moves one persistent bookmark from a folder to favorites and back without duplicates", () => {
    const file = tempFile("bookmarks.json");
    const store = new BookmarksStore(file);
    const folder = store.addFolder("project", "Research");
    const target = {
      projectId: "project",
      profileId: "profile",
      label: "Docs",
      url: "https://example.test/docs",
    };
    const first = store.place({ ...target, folderId: folder.id });
    store.place({ ...target, pinned: true });
    expect(store.forProject("project").bookmarks).toHaveLength(0);
    expect(store.pinned("profile").bookmarks).toEqual([
      { id: first.id, label: "Docs", url: target.url },
    ]);
    store.place({ ...target, folderId: folder.id });
    store.place({ ...target, folderId: folder.id });
    const restored = new BookmarksStore(file);
    expect(restored.pinned("profile").bookmarks).toHaveLength(0);
    expect(restored.forProject("project").bookmarks).toEqual([
      { ...first, folderId: folder.id },
    ]);
  });
  it("does not lose a bookmark when its drop folder has been removed", () => {
    const store = new BookmarksStore(tempFile("bookmarks.json"));
    const target = {
      projectId: "project",
      profileId: "profile",
      label: "Chat",
      url: "catamorphic://chat?project=project&session=session",
    };
    store.place({ ...target, pinned: true });
    expect(() => store.place({ ...target, folderId: "removed" })).toThrow(
      "no longer exists",
    );
    expect(store.pinned("profile").bookmarks).toHaveLength(1);
  });
});
