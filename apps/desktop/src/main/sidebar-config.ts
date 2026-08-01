import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * User-customizable sidebar. The config is a real JS file at
 * `<userData>/sidebar.js` (same philosophy as keybindings.json: plain,
 * user-visible, agent-editable, file-watched, applies live). The file
 * evaluates in an isolated vm context — no require/process/fs — and
 * exports an ordered list of sections.
 *
 * Section types the renderer knows how to draw:
 *  - "workflows" | "apps" | "chats"  — the built-in project sections
 *  - "bookmarks"                     — per-project browser bookmarks
 *  - "links"                         — static list of custom links
 *
 * Items/links carry an `open` attribute: "tab" opens a new browser tab,
 * "replace" navigates the current browser tab (falling back to a new tab
 * when the focused tab isn't a browser tab).
 */
export interface SidebarLink {
  label: string;
  url: string;
  open?: "tab" | "replace";
}

export interface SidebarSectionConfig {
  type: "workflows" | "apps" | "chats" | "bookmarks" | "links";
  /** Override the section heading. */
  title?: string;
  /** Start collapsed (default open). */
  collapsed?: boolean;
  /** For type "links": the static entries. */
  links?: SidebarLink[];
  /** For type "bookmarks": how bookmark clicks open. Default "tab". */
  open?: "tab" | "replace";
}

export interface SidebarConfig {
  sections: SidebarSectionConfig[];
}

export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = {
  sections: [
    { type: "workflows" },
    { type: "apps" },
    { type: "chats" },
    { type: "bookmarks" },
  ],
};

const DEFAULT_FILE_CONTENTS = `// Catamorphic sidebar configuration.
// This file is plain JavaScript, evaluated in a sandbox (no require/fs).
// Edit and save — the sidebar updates live.
//
// Section types:
//   "workflows" | "apps" | "chats"  built-in project sections
//   "bookmarks"                     per-project browser bookmarks
//   "links"                         your own static links
//
// Common attributes:
//   title:     override the section heading
//   collapsed: start collapsed
//   open:      "tab" (new browser tab) or "replace" (reuse the focused
//              browser tab; falls back to a new tab if the focused tab
//              isn't a browser tab). Default for bookmarks/links: "replace".

module.exports = {
  sections: [
    { type: "workflows" },
    { type: "apps" },
    { type: "chats" },
    { type: "bookmarks" },
    // {
    //   type: "links",
    //   title: "Docs",
    //   links: [
    //     { label: "MDN", url: "https://developer.mozilla.org", open: "tab" },
    //   ],
    // },
  ],
};
`;

const VALID_TYPES = new Set([
  "workflows",
  "apps",
  "chats",
  "bookmarks",
  "links",
]);

function sanitize(raw: unknown): SidebarConfig {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const rawSections = Array.isArray(record.sections) ? record.sections : [];
  const sections: SidebarSectionConfig[] = [];
  for (const entry of rawSections) {
    if (typeof entry !== "object" || entry === null) continue;
    const section = entry as Record<string, unknown>;
    if (typeof section.type !== "string" || !VALID_TYPES.has(section.type)) {
      continue;
    }
    const links = Array.isArray(section.links)
      ? section.links
          .filter(
            (link): link is Record<string, unknown> =>
              typeof link === "object" &&
              link !== null &&
              typeof (link as Record<string, unknown>).url === "string",
          )
          .map(
            (link): SidebarLink => ({
              label:
                typeof link.label === "string"
                  ? link.label
                  : String(link.url),
              url: String(link.url),
              open: link.open === "tab" ? "tab" : link.open === "replace" ? "replace" : undefined,
            }),
          )
      : undefined;
    sections.push({
      type: section.type as SidebarSectionConfig["type"],
      title: typeof section.title === "string" ? section.title : undefined,
      collapsed: section.collapsed === true,
      links,
      open:
        section.open === "tab"
          ? "tab"
          : section.open === "replace"
            ? "replace"
            : undefined,
    });
  }
  return sections.length > 0 ? { sections } : DEFAULT_SIDEBAR_CONFIG;
}

export class SidebarConfigStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  /** Write the commented default template on first run. */
  ensureFile(): void {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, DEFAULT_FILE_CONTENTS);
    }
  }

  load(): SidebarConfig {
    try {
      const source = fs.readFileSync(this.file, "utf-8");
      const module = { exports: {} as unknown };
      const context = vm.createContext({ module, exports: module.exports });
      vm.runInContext(source, context, {
        filename: this.file,
        timeout: 250,
      });
      return sanitize(module.exports);
    } catch (cause) {
      console.warn("[desktop] sidebar.js failed to evaluate:", cause);
      return DEFAULT_SIDEBAR_CONFIG;
    }
  }

  watch(onChange: (config: SidebarConfig) => void): void {
    const dir = path.dirname(this.file);
    const name = path.basename(this.file);
    this.watcher = fs.watch(dir, (_event, changed) => {
      if (changed !== name) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => onChange(this.load()), 100);
    });
  }

  dispose(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
  }
}
