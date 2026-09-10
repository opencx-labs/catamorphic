import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BookmarksStore } from "./bookmarks.js";

const dirs: string[] = [];
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bookmarks-store-"));
  dirs.push(dir);
  return {
    file: path.join(dir, "bookmarks.json"),
    value: new BookmarksStore(path.join(dir, "bookmarks.json")),
  };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("BookmarksStore", () => {
  it("places a tab in an imported pinned folder and preserves its identity on moves", () => {
    const { value, file } = store();
    value.importPinned("profile", {
      folders: [{ path: ["Tools"] }],
      bookmarks: [],
    });
    const folderId = value.pinned("profile").folders[0]?.id;
    expect(folderId).toBeTruthy();
    const bookmark = value.place({
      projectId: "project",
      profileId: "profile",
      label: "Docs",
      url: "https://example.com",
      pinned: true,
      folderId,
    });
    expect(value.pinned("profile").bookmarks).toEqual([bookmark]);
    expect(bookmark.folderId).toBe(folderId);
    expect(
      new BookmarksStore(file).pinned("profile").bookmarks[0]?.folderId,
    ).toBe(folderId);
    const moved = value.place({
      projectId: "project",
      profileId: "profile",
      label: "Docs",
      url: bookmark.url,
    });
    expect(moved.id).toBe(bookmark.id);
    expect(moved.folderId).toBeUndefined();
    expect(value.pinned("profile").bookmarks).toHaveLength(0);
  });

  it("imports a recursive profile bookmark tree idempotently", () => {
    const { value } = store();
    const imported = {
      folders: [
        { path: ["Dev"] },
        { path: ["Dev", "Tools"] },
        { path: ["Empty"] },
      ],
      bookmarks: [
        {
          label: "Bun",
          url: "https://bun.sh",
          folderPath: ["Dev", "Tools"],
        },
      ],
    };

    expect(value.importPinned("profile", imported)).toBe(1);
    expect(value.importPinned("profile", imported)).toBe(0);
    const tree = value.pinned("profile");
    expect(tree.folders.map((folder) => folder.label)).toEqual([
      "Dev",
      "Tools",
      "Empty",
    ]);
    const dev = tree.folders.find((folder) => folder.label === "Dev");
    const tools = tree.folders.find((folder) => folder.label === "Tools");
    expect(tools?.parentId).toBe(dev?.id);
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]?.folderId).toBe(tools?.id);
  });

  it("keeps imports in the library and preserves their folder after pinning and unpinning", () => {
    const { value, file } = store();
    const imported = {
      folders: [{ path: ["Work", "Docs"] }],
      bookmarks: [
        {
          label: "Docs",
          url: "https://example.com/docs",
          folderPath: ["Work", "Docs"],
        },
      ],
    };
    expect(value.importBookmarks("profile", imported)).toBe(1);
    expect(value.importBookmarks("profile", imported)).toBe(0);
    expect(value.pinned("profile").bookmarks).toHaveLength(0);
    const bookmark = value.library("profile").bookmarks[0];
    if (!bookmark) throw new Error("Missing imported bookmark");
    value.pin("project", "profile", bookmark.id);
    value.pin("project", "profile", bookmark.id);
    expect(value.pinned("profile").bookmarks).toHaveLength(1);
    expect(value.library("profile").bookmarks[0]?.folderId).toBe(
      bookmark.folderId,
    );
    value.unpin("profile", "project", bookmark.id);
    expect(value.pinned("profile").bookmarks).toHaveLength(0);
    expect(value.forProject("project").bookmarks).toHaveLength(0);
    expect(new BookmarksStore(file).library("profile").bookmarks).toEqual([
      bookmark,
    ]);
    expect(value.library("other-profile").bookmarks).toHaveLength(0);
    value.removeLibrary("profile", bookmark.folderId ?? "missing");
    expect(value.library("profile").bookmarks[0]?.folderId).toBe(
      value.library("profile").folders[0]?.id,
    );
  });

  it("migrates the former flat pinned array on read", () => {
    const { file } = store();
    fs.writeFileSync(
      file,
      JSON.stringify({
        byProject: {},
        pinnedByProfile: {
          profile: [
            { id: "one", label: "Example", url: "https://example.com" },
          ],
        },
      }),
    );

    expect(new BookmarksStore(file).pinned("profile")).toEqual({
      folders: [],
      bookmarks: [{ id: "one", label: "Example", url: "https://example.com" }],
    });
  });

  it("repairs folders for bookmarks flattened by an earlier import", () => {
    const { file } = store();
    fs.writeFileSync(
      file,
      JSON.stringify({
        byProject: {},
        pinnedByProfile: {
          profile: [{ id: "bun", label: "Bun", url: "https://bun.sh" }],
        },
      }),
    );
    const value = new BookmarksStore(file);

    expect(
      value.importPinned("profile", {
        folders: [{ path: ["Dev"] }, { path: ["Dev", "Tools"] }],
        bookmarks: [
          {
            label: "Bun",
            url: "https://bun.sh",
            folderPath: ["Dev", "Tools"],
          },
        ],
      }),
    ).toBe(0);
    const tree = value.pinned("profile");
    const tools = tree.folders.find((folder) => folder.label === "Tools");
    expect(tree.bookmarks[0]?.folderId).toBe(tools?.id);
  });

  it("moves an unpinned imported bookmark to the project root", () => {
    const { value } = store();
    value.importPinned("profile", {
      folders: [{ path: ["Imported"] }],
      bookmarks: [
        {
          label: "Example",
          url: "https://example.com",
          folderPath: ["Imported"],
        },
      ],
    });
    const imported = value.pinned("profile").bookmarks[0];
    expect(imported?.folderId).toBeDefined();

    value.unpin("profile", "project", imported?.id ?? "missing");

    expect(value.pinned("profile").bookmarks).toHaveLength(0);
    expect(value.forProject("project").bookmarks).toEqual([
      expect.objectContaining({
        label: "Example",
        url: "https://example.com",
        folderId: undefined,
      }),
    ]);
  });
});
