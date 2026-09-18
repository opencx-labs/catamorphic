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
  it("private loading copy only shrinks", () => {
    // Debt: screens that still print their own "Loading…" instead of the
    // shared status language. Lower this when you remove one.
    expect(count(/"Loading…"|>Loading…</g).length).toBeLessThanOrEqual(12);
  });
  it("native title tooltips only shrink", () => {
    // Debt: DESIGN.md wants ShortcutHint everywhere. Lower when you convert one.
    expect(count(/\stitle=\{|\stitle="/g).length).toBeLessThanOrEqual(66);
  });
});
