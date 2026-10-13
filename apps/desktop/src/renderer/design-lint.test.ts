import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The patterns behind the defects DESIGN.md forbids. Banned ones must not
 * exist; ratcheted ones are debt that may only shrink (lower the ceiling
 * when you remove an instance, never raise it).
 */
const ROOT = path.resolve(import.meta.dirname);
const sources = (): Array<{ file: string; text: string }> => {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name))
        out.push({
          file: path.relative(ROOT, full),
          text: fs.readFileSync(full, "utf8"),
        });
    }
  };
  walk(ROOT);
  return out;
};
const count = (pattern: RegExp) =>
  sources().flatMap(({ file, text }) =>
    [...text.matchAll(pattern)].map(() => file),
  );

describe("design lint", () => {
  it("hover-revealed controls use the shared reveal, never a private opacity toggle", () => {
    expect(
      count(
        /group-hover:opacity-100|group-focus-within:opacity-100|focus:opacity-100/g,
      ),
    ).toEqual([]);
  });
  it("no section carries a private drop-zone grammar", () => {
    expect(count(/data-bookmark-drop/g)).toEqual([]);
  });
  it("script-driven motion takes its duration from lib/motion", () => {
    const literal = sources()
      .filter(({ file }) => !file.startsWith("lib/motion"))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/\.animate\(\s*\[[\s\S]*?\{\s*duration:\s*\d+/g)].map(
          () => file,
        ),
      );
    expect(literal).toEqual([]);
  });
  it("rectangular actions use a button role, never a private accent recipe", () => {
    // Registry mirrors under components/catamorphic style through tokens
    // only: the desktop button classes do not exist for their other hosts.
    // Debt elsewhere: icon-only send buttons and pills; lower this when you
    // convert one to `button-primary`.
    const recipes = sources()
      .filter(({ file }) => !file.startsWith("components/catamorphic/"))
      .flatMap(({ file, text }) =>
        [
          ...text.matchAll(
            /className="[^"]*\bbg-accent\s[^"]*\b(px-|text-accent-fg)/g,
          ),
        ].map(() => file),
      );
    expect(recipes.length).toBeLessThanOrEqual(3);
  });
  it("destructive confirms use the danger role, never solid red with white text", () => {
    expect(count(/className="[^"]*\bbg-danger\b[^"]*\btext-white\b/g)).toEqual(
      [],
    );
  });
  it("private loading copy only shrinks", () => {
    // Debt: screens that still print their own "Loading…" instead of the
    // shared status language. Lower this when you remove one.
    expect(count(/"Loading…"|>Loading…</g).length).toBeLessThanOrEqual(11);
  });
  it("native title tooltips only shrink", () => {
    // Debt: DESIGN.md wants ShortcutHint everywhere. Lower when you convert one.
    // Registry mirrors under components/catamorphic fall back to the native
    // title only when a host gives no hint; the desktop passes ShortcutHint.
    const titles = sources()
      .filter(({ file }) => !file.startsWith("components/catamorphic/"))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/\stitle=\{|\stitle="/g)].map(() => file),
      );
    expect(titles.length).toBeLessThanOrEqual(56);
  });
  // DESIGN.md "Menus and popovers" (ADR 0221): one primitive owns each
  // kind of dismissal, presses inside pages and app frames included, which
  // the window never sees itself. Registry mirrors under
  // components/catamorphic are installed copies their hosts dismiss.
  const appSources = () =>
    sources().filter(({ file }) => !file.startsWith("components/catamorphic/"));
  const occurrences = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].length;
  /** A menu MenuPortal draws, or a native one main builds. */
  const menusDrawn = (text: string) =>
    occurrences(text, /<MenuPortal\b/g) +
    occurrences(text, /desktopApi\.\w+Menu\(/g);
  const closesThroughPrimitive = (text: string) =>
    /\busePopoverDismiss\(/.test(text) || menusDrawn(text) > 0;

  it("menus open through MenuPortal, never a hand-rolled dropdown", () => {
    // Attributes and elements, not selectors such as '[role="menu"]'.
    const handRolled = appSources()
      .filter(({ file }) => file !== "components/menu.tsx")
      .flatMap(({ file, text }) => {
        if (/\srole(?:=|: )"menu"/.test(text)) return [`${file}: role="menu"`];
        // Each ⋯ button or menu button needs a menu of its own drawn.
        const controls = Math.max(
          occurrences(text, /\s"?aria-haspopup"?(?:=|: )\{?"menu"/g),
          occurrences(
            text,
            /<(?:MoreHorizontal|MoreVertical|Ellipsis|EllipsisVertical)(?:Icon)?\b/g,
          ),
        );
        return controls > menusDrawn(text)
          ? [`${file}: ${controls} menu controls, ${menusDrawn(text)} menus`]
          : [];
      });
    expect(handRolled).toEqual([]);
  });

  it("whatever pops up closes through usePopoverDismiss or a menu", () => {
    // A control that says it opens a popup (aria-haspopup, any value), or
    // a popup role, in a file with neither primitive. The rest close some
    // other way, said here.
    const ownDismissal: Record<string, string> = {
      "components/menu.tsx": "the menu primitive",
      "components/resource-inspector.tsx": "the hover inspector primitive",
      "components/modal.tsx": "the dialog primitive: backdrop and Escape",
      "components/command-palette.tsx":
        "a modal overlay that holds focus and closes on Escape",
      "components/extensions/extension-popup.tsx":
        "an extension's page: closes as focus leaves it and on page presses",
      "components/password-autofill.tsx":
        "bound to a page's field, closing with the field's blur",
      "components/password-prompt.tsx":
        "Chrome's password bubble: it waits for an answer",
      "components/slash-menu.tsx":
        "bound to the composer's text, closing as the text changes",
    };
    const unclosed = appSources()
      .filter(({ file }) => !(file in ownDismissal))
      .filter(
        ({ text }) =>
          /\saria-haspopup\b|"aria-haspopup"|\srole(?:=|: )"(?:listbox|dialog)"/.test(
            text,
          ) && !closesThroughPrimitive(text),
      )
      .map(({ file }) => file);
    expect(unclosed).toEqual([]);
  });

  it("window-wide input listeners are listed with what they are for", () => {
    // A popover's own press or Escape listener misses presses inside
    // pages; usePopoverDismiss and MenuPortal hear them. Every other
    // window, document or body listener for presses and keys is listed
    // here with its job, at most as many as listed (lower a count when
    // you remove one).
    const allowed: Record<string, { count: number; reason: string }> = {
      "app.tsx": {
        count: 5,
        reason:
          "workspace shortcuts, mouse back and forward buttons, the split divider's drag, which floating chat was last pressed and a chat's step-down handoff",
      },
      "components/chat-dock.tsx": {
        count: 3,
        reason: "a press outside folds the chat; Escape minimizes it",
      },
      "components/command-palette.tsx": {
        count: 3,
        reason: "the palette's keys and its deferred focus giving way",
      },
      "components/dock-host.tsx": { count: 1, reason: "chat dock shortcuts" },
      "components/extensions/extension-popup.tsx": {
        count: 2,
        reason: "an extension's popup page, which takes no hover card",
      },
      "components/extensions/extension-side-panel.tsx": {
        count: 1,
        reason: "ends the side panel's resize drag",
      },
      "components/markdown/bubble-menu.tsx": {
        count: 1,
        reason: "shows the format bar once a selection drag ends",
      },
      "components/markdown/row-drag.ts": {
        count: 1,
        reason: "ends a row drag",
      },
      "components/menu.tsx": { count: 2, reason: "the menu primitive" },
      "components/modal.tsx": { count: 1, reason: "the dialog primitive" },
      "components/password-autofill.tsx": {
        count: 1,
        reason: "a press in the window closes a page field's suggestions",
      },
      "components/resource-inspector.tsx": {
        count: 3,
        reason: "the hover inspector primitive",
      },
      "components/shortcut-hint.tsx": {
        count: 3,
        reason: "tooltips hide on any press or key",
      },
      "components/sidebar-item-row.tsx": {
        count: 1,
        reason: "Escape closes a row's hover preview",
      },
      "screens/settings-screen.tsx": {
        count: 2,
        reason: "recording a shortcut takes the next key",
      },
      "screens/terminal-screen.tsx": {
        count: 1,
        reason: "ends a selection drag",
      },
      "lib/app-focus.ts": {
        count: 2,
        reason: "counts the person's input for focus the app moves",
      },
      "lib/focus-modality.ts": {
        count: 2,
        reason: "keyboard or pointer leads, for focus rings",
      },
      "lib/popover-dismiss.ts": { count: 2, reason: "the popover primitive" },
    };
    const listener =
      /(?:\b(?:window|document|globalThis|doc)(?:\.body)?|\bownerDocument)\s*\.\s*addEventListener\(\s*"(?:pointerdown|mousedown|mouseup|click|keydown|keyup)"/g;
    const over = appSources().flatMap(({ file, text }) => {
      const found = occurrences(text, listener);
      const limit = allowed[file]?.count ?? 0;
      return found > limit ? [`${file}: ${found} > ${limit}`] : [];
    });
    expect(over).toEqual([]);
  });
  it("focus rings come from the ring tokens, never a private recipe", () => {
    // One ring (DESIGN.md "Focus rings"): the global :focus-visible rule or
    // `.focus-ring-inset`. Private utilities drifted to 1px rings, 2px and
    // 4px offsets, and rings that ignored the keyboard-navigation gate.
    expect(
      count(/\b(?:focus|focus-visible|focus-within):(?:outline|ring)\b/g),
    ).toEqual([]);
    expect(count(/outline:\s*\d+px\s+solid/g)).toEqual([]);
  });
  it("switches are checkboxes with role=switch, never a private control", () => {
    // DESIGN.md "Switches": form-controls.css draws the one switch.
    expect(count(/<(?!input\b)[a-z]+\b[^>]*\brole="switch"/g)).toEqual([]);
  });
  it("checkboxes carry no private chrome", () => {
    // form-controls.css draws every checkbox; per-site sizes and accent
    // colors made some 14px and fought the shared mark.
    const privateChrome = sources().flatMap(({ file, text }) =>
      [...text.matchAll(/<input\b(?:(?!<input\b)[\s\S])*?\/>/g)]
        .filter(([element]) => element.includes('type="checkbox"'))
        .filter(([element]) =>
          /className=(?:"|\{[`"]?)[^"}`]*\b(?:size-|w-|h-|accent-|border|bg-|rounded)/.test(
            element,
          ),
        )
        .map(() => file),
    );
    expect(privateChrome).toEqual([]);
  });
});
