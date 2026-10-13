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
  it("menus open through MenuPortal, never a hand-rolled dropdown", () => {
    // DESIGN.md "Menus and popovers" (ADR 0221): MenuPortal owns placement,
    // keys and dismissal, presses inside pages and app frames included. A
    // file with a menu's semantics or an overflow (⋯) button that draws no
    // MenuPortal and asks main for no native menu (desktopApi.*Menu) holds
    // a hand-rolled dropdown that nothing closes. Registry mirrors under
    // components/catamorphic are their hosts' to dismiss.
    // Attributes, not selectors such as '[role="menu"]' that find menus.
    const menuSignals =
      /\srole(?:=|: )"menu"|\s"?aria-haspopup"?(?:=|: )"menu"|\b(?:MoreHorizontal|MoreVertical|Ellipsis|EllipsisVertical)\b/;
    const handRolled = sources()
      .filter(
        ({ file }) =>
          !file.startsWith("components/catamorphic/") &&
          file !== "components/menu.tsx",
      )
      .filter(
        ({ text }) =>
          menuSignals.test(text) &&
          !/<MenuPortal\b|desktopApi\.\w+Menu\(/.test(text),
      )
      .map(({ file }) => file);
    expect(handRolled).toEqual([]);
  });
  it("popovers close through usePopoverDismiss; their own press listeners only shrink", () => {
    // DESIGN.md "Menus and popovers": a popover's own window or document
    // press listener misses presses inside pages, which run in their own
    // process. Primitives (menu, hover inspector, tooltip, lib/) are the
    // dismissal's owners. Debt: lower this when you convert one.
    const primitives = new Set([
      "components/menu.tsx",
      "components/resource-inspector.tsx",
      "components/shortcut-hint.tsx",
    ]);
    const listeners = sources()
      .filter(
        ({ file }) =>
          !primitives.has(file) &&
          !file.startsWith("lib/") &&
          !file.startsWith("components/catamorphic/"),
      )
      .flatMap(({ file, text }) =>
        [
          ...text.matchAll(
            /(?:window|document)\.addEventListener\(\s*"(?:pointerdown|mousedown)"/g,
          ),
        ].map(() => file),
      );
    expect(listeners.length).toBeLessThanOrEqual(6);
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
