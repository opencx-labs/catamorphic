import { describe, expect, it, vi } from "vitest";
import { isMenuSeparator, type MenuItem } from "../shared/menu.js";
import {
  linkAddress,
  type MenuPage,
  menuActions,
  type PageMenuHost,
  type PageMenuState,
  type PageMenuTarget,
  pageMenu,
  quoteSelection,
  runPageMenuAction,
} from "./page-menu.js";

const PAGE = "https://example.test/article";

const target = (patch: Partial<PageMenuTarget> = {}): PageMenuTarget => ({
  x: 40,
  y: 60,
  pageURL: PAGE,
  linkURL: "",
  srcURL: "",
  mediaType: "none",
  selectionText: "",
  isEditable: false,
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: false,
  },
  misspelledWord: "",
  dictionarySuggestions: [],
  ...patch,
});

const state = (patch: Partial<PageMenuState> = {}): PageMenuState => ({
  canGoBack: true,
  canGoForward: false,
  mac: false,
  emojiPanel: false,
  credentials: null,
  extensions: [],
  ...patch,
});

/** The menu as people read it: labels, "—" for rules, "(off)" for disabled. */
const read = (items: readonly MenuItem[]) =>
  items.map((item) =>
    isMenuSeparator(item)
      ? "—"
      : item.disabledReason
        ? `${item.label} (off)`
        : item.label,
  );

describe("pageMenu", () => {
  it("offers a link's destinations and its address", () => {
    expect(
      read(pageMenu(target({ linkURL: "https://example.test/next" }), state())),
    ).toEqual([
      "Open link in new tab",
      "Open link to the side",
      "Open link floating",
      "—",
      "Copy link address",
      "Download linked file",
      "—",
      "Inspect",
    ]);
  });

  it("writes to an email address and calls a phone number", () => {
    expect(
      read(pageMenu(target({ linkURL: "mailto:ada@example.test" }), state())),
    ).toEqual(["Send email", "Copy email address", "—", "Inspect"]);
    expect(
      read(pageMenu(target({ linkURL: "tel:+15550100" }), state())),
    ).toEqual(["Call", "Copy phone number", "—", "Inspect"]);
    expect(
      read(pageMenu(target({ linkURL: "slack://open" }), state())),
    ).toEqual(["Copy link address", "—", "Inspect"]);
  });

  it("names the address without its scheme or query", () => {
    expect(linkAddress("mailto:ada%40example.test?subject=Hi")).toBe(
      "ada@example.test",
    );
    expect(linkAddress("tel:+1%20555%200100")).toBe("+1 555 0100");
  });

  it("offers an image linked to a page both ways, the link first", () => {
    expect(
      read(
        pageMenu(
          target({
            linkURL: "https://example.test/gallery",
            mediaType: "image",
            srcURL: "https://cdn.example.test/cat.png",
          }),
          state(),
        ),
      ),
    ).toEqual([
      "Open link in new tab",
      "Open link to the side",
      "Open link floating",
      "—",
      "Copy link address",
      "Download linked file",
      "—",
      "Open image in new tab",
      "Download image",
      "Copy image",
      "Copy image address",
      "—",
      "Inspect",
    ]);
    // An inline image has no address worth opening or copying.
    expect(
      read(
        pageMenu(
          target({ mediaType: "image", srcURL: "data:image/png;base64,AA" }),
          state(),
        ),
      ),
    ).toEqual(["Download image", "Copy image", "—", "Inspect"]);
  });

  it("copies and searches selected text, and looks it up on macOS", () => {
    const selected = target({
      selectionText:
        "  Catamorphisms generalize\nfolds over any algebraic data type  ",
    });
    expect(read(pageMenu(selected, state({ mac: true })))).toEqual([
      "Copy",
      "Search Google for “Catamorphisms generalize folds…”",
      "Look up “Catamorphisms generalize folds…”",
      "—",
      "Inspect",
    ]);
    expect(read(pageMenu(selected, state()))).toEqual([
      "Copy",
      "Search Google for “Catamorphisms generalize folds…”",
      "—",
      "Inspect",
    ]);
    expect(quoteSelection("short")).toBe("“short”");
    expect(quoteSelection("Supercalifragilisticexpialidocious words")).toBe(
      "“Supercalifragilisticexpialidoci…”",
    );
  });

  it("edits a text field, with what cannot happen turned off", () => {
    const field = target({
      isEditable: true,
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: true,
        canSelectAll: true,
      },
    });
    const items = pageMenu(field, state({ emojiPanel: true }));
    expect(read(items)).toEqual([
      "Undo",
      "Redo (off)",
      "—",
      "Cut (off)",
      "Copy (off)",
      "Paste",
      "Paste and match style",
      "Select all",
      "—",
      "Emoji and symbols",
      "—",
      "Inspect",
    ]);
    expect(menuActions(items)).not.toContain("redo");
  });

  it("puts spelling suggestions first in a misspelled word", () => {
    const misspelled = target({
      isEditable: true,
      selectionText: "",
      misspelledWord: "recieve",
      dictionarySuggestions: ["receive", "relieve"],
    });
    expect(read(pageMenu(misspelled, state())).slice(0, 4)).toEqual([
      "receive",
      "relieve",
      "Add to dictionary",
      "—",
    ]);
    expect(
      read(
        pageMenu({ ...misspelled, dictionarySuggestions: [] }, state()),
      ).slice(0, 2),
    ).toEqual(["No suggestions (off)", "Add to dictionary"]);
  });

  it("offers saved sign-ins in a password field", () => {
    const items = pageMenu(
      target({ isEditable: true }),
      state({ credentials: [{ id: "c1", username: "ada" }] }),
    );
    expect(read(items).slice(0, 3)).toEqual([
      "ada",
      "Suggest strong password",
      "—",
    ]);
  });

  it("acts on the page itself where nothing else was clicked", () => {
    expect(read(pageMenu(target(), state()))).toEqual([
      "Back",
      "Forward (off)",
      "Reload",
      "—",
      "Copy page address",
      "Print…",
      "View page source",
      "—",
      "Inspect",
    ]);
  });

  it("adds extensions' items before Inspect", () => {
    const items = pageMenu(
      target({ selectionText: "word" }),
      state({
        extensions: [{ label: "Translate “word”", action: "extension:abc:1" }],
      }),
    );
    expect(read(items).slice(-3)).toEqual(["Translate “word”", "—", "Inspect"]);
  });
});

function fakePage(url = PAGE) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(args.length > 0 ? `${name}(${args.join(", ")})` : name);
    };
  const page: MenuPage = {
    isDestroyed: () => false,
    getURL: () => url,
    focus: record("focus"),
    navigationHistory: { goToOffset: record("history") },
    reload: record("reload"),
    print: record("print"),
    undo: record("undo"),
    redo: record("redo"),
    cut: record("cut"),
    copy: record("copy"),
    paste: record("paste"),
    pasteAndMatchStyle: record("pasteAndMatchStyle"),
    selectAll: record("selectAll"),
    replaceMisspelling: record("replaceMisspelling"),
    showDefinitionForSelection: record("showDefinitionForSelection"),
    copyImageAt: record("copyImageAt"),
    downloadURL: record("downloadURL"),
    inspectElement: record("inspectElement"),
    session: {
      addWordToSpellCheckerDictionary: (word: string) => {
        calls.push(`learn(${word})`);
        return true;
      },
    },
  };
  return { page, calls };
}

function fakeHost() {
  const host = {
    openUrl: vi.fn(),
    writeText: vi.fn(),
    openExternal: vi.fn(),
    showEmojiPanel: vi.fn(),
    fillCredential: vi.fn(),
    suggestPassword: vi.fn(),
    runExtension: vi.fn(() => true),
  } satisfies PageMenuHost;
  return host;
}

describe("runPageMenuAction", () => {
  it("opens links where asked and copies addresses", () => {
    const { page } = fakePage();
    const host = fakeHost();
    const link = target({ linkURL: "https://example.test/next" });
    runPageMenuAction({ action: "open-link:side", target: link, page, host });
    expect(host.openUrl).toHaveBeenCalledWith(
      "https://example.test/next",
      "side",
    );
    runPageMenuAction({ action: "copy-link", target: link, page, host });
    expect(host.writeText).toHaveBeenLastCalledWith(
      "https://example.test/next",
    );
    const mail = target({ linkURL: "mailto:ada@example.test?subject=Hi" });
    runPageMenuAction({ action: "copy-address", target: mail, page, host });
    expect(host.writeText).toHaveBeenLastCalledWith("ada@example.test");
    runPageMenuAction({ action: "open-external", target: mail, page, host });
    expect(host.openExternal).toHaveBeenCalledWith(
      "mailto:ada@example.test?subject=Hi",
    );
  });

  it("searches the selection and shows a page's source in new tabs", () => {
    const { page } = fakePage();
    const host = fakeHost();
    runPageMenuAction({
      action: "search",
      target: target({ selectionText: " fold & unfold " }),
      page,
      host,
    });
    expect(host.openUrl).toHaveBeenCalledWith(
      "https://www.google.com/search?q=fold%20%26%20unfold",
      "tab",
    );
    runPageMenuAction({ action: "view-source", target: target(), page, host });
    expect(host.openUrl).toHaveBeenLastCalledWith(`view-source:${PAGE}`, "tab");
  });

  it("returns focus to the field before editing it", () => {
    const { page, calls } = fakePage();
    const host = fakeHost();
    for (const action of ["paste", "spelling:receive", "learn-spelling"])
      runPageMenuAction({
        action,
        target: target({ isEditable: true, misspelledWord: "recieve" }),
        page,
        host,
      });
    expect(calls).toEqual([
      "focus",
      "paste",
      "focus",
      "replaceMisspelling(receive)",
      "focus",
      "learn(recieve)",
    ]);
  });

  it("leaves a page that moved on since the right-click alone", () => {
    const { page, calls } = fakePage("https://example.test/elsewhere");
    const host = fakeHost();
    runPageMenuAction({ action: "paste", target: target(), page, host });
    runPageMenuAction({ action: "fill:c1", target: target(), page, host });
    expect(calls).toEqual([]);
    expect(host.fillCredential).not.toHaveBeenCalled();
    // What the menu already holds still works.
    runPageMenuAction({
      action: "copy-link",
      target: target({ linkURL: "https://example.test/next" }),
      page,
      host,
    });
    expect(host.writeText).toHaveBeenCalledWith("https://example.test/next");
  });

  it("acts on images, the page and extensions' items", () => {
    const { page, calls } = fakePage();
    const host = fakeHost();
    const image = target({
      mediaType: "image",
      srcURL: "https://cdn.example.test/cat.png",
    });
    for (const action of ["copy-image", "download-media", "inspect", "back"])
      runPageMenuAction({ action, target: image, page, host });
    expect(calls).toEqual([
      "focus",
      "copyImageAt(40, 60)",
      "downloadURL(https://cdn.example.test/cat.png)",
      "focus",
      "inspectElement(40, 60)",
      "history(-1)",
    ]);
    runPageMenuAction({
      action: "extension:abc:1",
      target: image,
      page,
      host,
    });
    expect(host.runExtension).toHaveBeenCalledWith("extension:abc:1");
  });
});
