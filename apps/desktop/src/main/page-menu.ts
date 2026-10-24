import {
  isMenuSeparator,
  MENU_SEPARATOR,
  type MenuItem,
  menuGroups,
} from "../shared/menu.js";
import type { OpenMode } from "../shared/open-mode.js";

/**
 * A page's context menu, as Chrome builds one: what was right-clicked (a
 * link, an email address, a phone number, an image or video, selected
 * text, a text field, or the page itself) decides the groups, and every
 * menu ends with Inspect. Built here as data so the window draws it like
 * every other menu of the app (ADR 0221); `runPageMenuAction` carries out
 * the pick.
 */

/** What the right-click named: the part of Electron's params the menu reads. */
export interface PageMenuTarget {
  x: number;
  y: number;
  pageURL: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
  misspelledWord: string;
  dictionarySuggestions: readonly string[];
}

/** The menu's reading of Electron's params (no frames or live objects). */
export function pageMenuTargetOf(
  params: Electron.ContextMenuParams,
): PageMenuTarget {
  const { editFlags } = params;
  return {
    x: params.x,
    y: params.y,
    pageURL: params.pageURL,
    linkURL: params.linkURL,
    srcURL: params.srcURL,
    mediaType: params.mediaType,
    selectionText: params.selectionText,
    isEditable: params.isEditable,
    editFlags: {
      canUndo: editFlags.canUndo,
      canRedo: editFlags.canRedo,
      canCut: editFlags.canCut,
      canCopy: editFlags.canCopy,
      canPaste: editFlags.canPaste,
      canSelectAll: editFlags.canSelectAll,
    },
    misspelledWord: params.misspelledWord,
    dictionarySuggestions: params.dictionarySuggestions,
  };
}

/** Every action a pick from `items` may name: enabled entries, nested too. */
export function menuActions(items: readonly MenuItem[]): string[] {
  return items.flatMap((item) =>
    isMenuSeparator(item) || item.disabledReason
      ? []
      : item.submenu
        ? menuActions(item.submenu)
        : [item.action],
  );
}

export interface PageMenuState {
  canGoBack: boolean;
  canGoForward: boolean;
  mac: boolean;
  /** The OS has a character viewer to open (macOS, Windows). */
  emojiPanel: boolean;
  /** Saved sign-ins offered in a password field; null elsewhere. */
  credentials: readonly { id: string; username: string }[] | null;
  /** Items extensions added (chrome.contextMenus), actions already named. */
  extensions: readonly MenuItem[];
}

const LINK_OPENS: readonly { mode: OpenMode; label: string }[] = [
  { mode: "tab", label: "Open link in new tab" },
  { mode: "side", label: "Open link to the side" },
  { mode: "floating", label: "Open link floating" },
];

/** Selected text as a label quotes it: one line, at most a few words. */
export function quoteSelection(text: string, max = 32): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return `“${line}”`;
  const cut = line.slice(0, max - 1);
  // Whole words where there is a break late enough to keep most of it.
  const space = cut.lastIndexOf(" ");
  return `“${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…”`;
}

function scheme(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

const isWeb = (url: string) => {
  const protocol = scheme(url);
  return protocol === "http:" || protocol === "https:";
};

/** The address of a mailto: or tel: link, without its query. */
export function linkAddress(url: string): string {
  const colon = url.indexOf(":");
  const rest = url.slice(colon + 1).split("?")[0] ?? "";
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

function linkGroup(url: string): MenuItem[] {
  if (!url) return [];
  const protocol = scheme(url);
  if (protocol === "http:" || protocol === "https:")
    return [
      ...LINK_OPENS.map(({ mode, label }) => ({
        label,
        action: `open-link:${mode}`,
      })),
      MENU_SEPARATOR,
      { label: "Copy link address", action: "copy-link" },
      { label: "Download linked file", action: "download-link" },
    ];
  if (protocol === "mailto:")
    return [
      { label: "Send email", action: "open-external" },
      { label: "Copy email address", action: "copy-address" },
    ];
  if (protocol === "tel:")
    return [
      { label: "Call", action: "open-external" },
      { label: "Copy phone number", action: "copy-address" },
    ];
  return [{ label: "Copy link address", action: "copy-link" }];
}

function mediaGroup(target: PageMenuTarget): MenuItem[] {
  const noun =
    target.mediaType === "image"
      ? "image"
      : target.mediaType === "video"
        ? "video"
        : target.mediaType === "audio"
          ? "audio"
          : null;
  if (!noun || !target.srcURL) return [];
  const web = isWeb(target.srcURL);
  return [
    ...(web
      ? [{ label: `Open ${noun} in new tab`, action: "open-media" }]
      : []),
    ...(web || noun === "image"
      ? [{ label: `Download ${noun}`, action: "download-media" }]
      : []),
    ...(noun === "image"
      ? [{ label: "Copy image", action: "copy-image" }]
      : []),
    ...(web
      ? [{ label: `Copy ${noun} address`, action: "copy-media-address" }]
      : []),
  ];
}

function spellingGroup(target: PageMenuTarget): MenuItem[] {
  if (!target.isEditable || !target.misspelledWord) return [];
  const suggestions = target.dictionarySuggestions.slice(0, 5);
  return [
    ...(suggestions.length > 0
      ? suggestions.map((word) => ({ label: word, action: `spelling:${word}` }))
      : [
          {
            label: "No suggestions",
            action: "no-suggestions",
            disabledReason: "The dictionary has no suggestions for this word",
          },
        ]),
    { label: "Add to dictionary", action: "learn-spelling" },
  ];
}

function selectionGroup(target: PageMenuTarget, mac: boolean): MenuItem[] {
  const text = target.selectionText.trim();
  if (!text) return [];
  return [
    ...(target.isEditable ? [] : [{ label: "Copy", action: "copy" }]),
    { label: `Search Google for ${quoteSelection(text)}`, action: "search" },
    ...(mac
      ? [{ label: `Look up ${quoteSelection(text)}`, action: "look-up" }]
      : []),
  ];
}

function editGroups(
  target: PageMenuTarget,
  state: PageMenuState,
): MenuItem[][] {
  if (!target.isEditable) return [];
  const flags = target.editFlags;
  const entry = (
    label: string,
    action: string,
    can: boolean,
    reason: string,
  ) => ({ label, action, ...(can ? {} : { disabledReason: reason }) });
  return [
    [
      entry("Undo", "undo", flags.canUndo, "Nothing to undo"),
      entry("Redo", "redo", flags.canRedo, "Nothing to redo"),
    ],
    [
      entry("Cut", "cut", flags.canCut, "Select text to cut"),
      entry("Copy", "copy", flags.canCopy, "Select text to copy"),
      entry("Paste", "paste", flags.canPaste, "Nothing to paste"),
      entry(
        "Paste and match style",
        "paste-plain",
        flags.canPaste,
        "Nothing to paste",
      ),
      entry(
        "Select all",
        "select-all",
        flags.canSelectAll,
        "Nothing to select",
      ),
    ],
    state.emojiPanel ? [{ label: "Emoji and symbols", action: "emoji" }] : [],
  ];
}

function credentialGroup(state: PageMenuState): MenuItem[] {
  if (!state.credentials) return [];
  return [
    ...state.credentials.map((credential) => ({
      label: credential.username || "Saved password",
      action: `fill:${credential.id}`,
    })),
    { label: "Suggest strong password", action: "suggest-password" },
  ];
}

function pageGroups(state: PageMenuState): MenuItem[][] {
  return [
    [
      {
        label: "Back",
        action: "back",
        ...(state.canGoBack ? {} : { disabledReason: "No earlier page" }),
      },
      {
        label: "Forward",
        action: "forward",
        ...(state.canGoForward ? {} : { disabledReason: "No later page" }),
      },
      { label: "Reload", action: "reload" },
    ],
    [
      { label: "Copy page address", action: "copy-page-address" },
      { label: "Print…", action: "print" },
      { label: "View page source", action: "view-source" },
    ],
  ];
}

export function pageMenu(
  target: PageMenuTarget,
  state: PageMenuState,
): MenuItem[] {
  const media = mediaGroup(target);
  const onPage =
    !target.linkURL &&
    media.length === 0 &&
    !target.selectionText.trim() &&
    !target.isEditable;
  return menuGroups(
    credentialGroup(state),
    spellingGroup(target),
    linkGroup(target.linkURL),
    media,
    selectionGroup(target, state.mac),
    ...editGroups(target, state),
    ...(onPage ? pageGroups(state) : []),
    state.extensions,
    [{ label: "Inspect", action: "inspect" }],
  );
}

/** The page a menu acts on: the WebContents methods it calls. */
export interface MenuPage {
  isDestroyed(): boolean;
  getURL(): string;
  focus(): void;
  navigationHistory: { goToOffset(offset: number): void };
  reload(): void;
  print(): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  pasteAndMatchStyle(): void;
  selectAll(): void;
  replaceMisspelling(text: string): void;
  showDefinitionForSelection(): void;
  copyImageAt(x: number, y: number): void;
  downloadURL(url: string): void;
  inspectElement(x: number, y: number): void;
  session: { addWordToSpellCheckerDictionary(word: string): boolean };
}

/** What a pick needs from outside the page. */
export interface PageMenuHost {
  openUrl(url: string, mode: OpenMode): void;
  writeText(text: string): void;
  openExternal(url: string): void;
  showEmojiPanel(): void;
  fillCredential(id: string): void;
  suggestPassword(): void;
  /** An extension's item; false when the action is not one. */
  runExtension(action: string): boolean;
}

/** These act on what is in the page now: a page that moved on skips them. */
const PAGE_BOUND = new Set([
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "paste-plain",
  "select-all",
  "learn-spelling",
  "look-up",
  "copy-image",
  "emoji",
  "inspect",
]);

export function runPageMenuAction({
  action,
  target,
  page,
  host,
}: {
  action: string;
  target: PageMenuTarget;
  page: MenuPage;
  host: PageMenuHost;
}): void {
  if (page.isDestroyed()) return;
  const bound =
    PAGE_BOUND.has(action) ||
    action.startsWith("spelling:") ||
    action.startsWith("fill:") ||
    action === "suggest-password";
  if (bound && page.getURL() !== target.pageURL) return;
  // Edits land in the field the right-click was in, which the menu took
  // focus from.
  if (bound) page.focus();
  const linkOpen = LINK_OPENS.find(
    ({ mode }) => action === `open-link:${mode}`,
  );
  if (linkOpen) {
    host.openUrl(target.linkURL, linkOpen.mode);
    return;
  }
  if (action.startsWith("spelling:")) {
    page.replaceMisspelling(action.slice("spelling:".length));
    return;
  }
  if (action.startsWith("fill:")) {
    host.fillCredential(action.slice("fill:".length));
    return;
  }
  switch (action) {
    case "copy-link":
      host.writeText(target.linkURL);
      return;
    case "download-link":
      page.downloadURL(target.linkURL);
      return;
    case "open-external":
      host.openExternal(target.linkURL);
      return;
    case "copy-address":
      host.writeText(linkAddress(target.linkURL));
      return;
    case "open-media":
      host.openUrl(target.srcURL, "tab");
      return;
    case "download-media":
      page.downloadURL(target.srcURL);
      return;
    case "copy-image":
      page.copyImageAt(target.x, target.y);
      return;
    case "copy-media-address":
      host.writeText(target.srcURL);
      return;
    case "search":
      host.openUrl(
        `https://www.google.com/search?q=${encodeURIComponent(target.selectionText.trim())}`,
        "tab",
      );
      return;
    case "look-up":
      page.showDefinitionForSelection();
      return;
    case "learn-spelling":
      page.session.addWordToSpellCheckerDictionary(target.misspelledWord);
      return;
    case "undo":
      page.undo();
      return;
    case "redo":
      page.redo();
      return;
    case "cut":
      page.cut();
      return;
    case "copy":
      page.copy();
      return;
    case "paste":
      page.paste();
      return;
    case "paste-plain":
      page.pasteAndMatchStyle();
      return;
    case "select-all":
      page.selectAll();
      return;
    case "emoji":
      host.showEmojiPanel();
      return;
    case "suggest-password":
      host.suggestPassword();
      return;
    case "back":
      page.navigationHistory.goToOffset(-1);
      return;
    case "forward":
      page.navigationHistory.goToOffset(1);
      return;
    case "reload":
      page.reload();
      return;
    case "copy-page-address":
      host.writeText(target.pageURL);
      return;
    case "print":
      page.print();
      return;
    case "view-source":
      host.openUrl(`view-source:${target.pageURL}`, "tab");
      return;
    case "inspect":
      page.inspectElement(target.x, target.y);
      return;
    default:
      host.runExtension(action);
  }
}
