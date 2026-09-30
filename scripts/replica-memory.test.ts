import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * A control-plane replica's memory holds only (a) working state of work it
 * claimed through a Postgres lease (or a request it is serving), rebuildable
 * if lost; (b) caches keyed by content hash or database revision; (c)
 * registries built identically at boot on every replica (ADR 0193).
 * Anything other replicas observe, fence on, or must exclude lives in
 * Postgres.
 *
 * Every class-level `Map` or `Set` in core services and the Work server says
 * which it is, in the comment right above it: `Replica memory (a)`, `(b)`,
 * or `(c)`, with its reason. An in-memory implementation a host swaps for a
 * shared one when it runs several replicas says `Replica memory (single
 * process)`.
 */
const root = path.resolve(import.meta.dirname, "..");
const SCANNED = ["packages/core/src/services", "packages/work-server/src"];

const FIELD =
  /^\s+(?:(?:private|protected|public|readonly|static|override)\s+)+#?\w+\s*(?::\s*(?:Readonly)?(?:Map|Set|WeakMap|WeakSet)\b[^=]*)?(?:=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b.*)?[;,]?$/;
const COLLECTION = /\b(?:Readonly)?(?:Map|Set|WeakMap|WeakSet)\b/;
const MARKER = /Replica memory \((?:a|b|c|single process)\)/;

function sources(dir: string): string[] {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory())
        return entry.name === "__tests__" ? [] : sources(relative);
      return entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
        ? [relative]
        : [];
    });
}

/** The contiguous comment block right above `index`. */
function commentAbove(lines: readonly string[], index: number): string {
  const block: string[] = [];
  for (let line = index - 1; line >= 0; line--) {
    const text = lines[line]?.trim() ?? "";
    if (
      !(
        text.startsWith("//") ||
        text.startsWith("/*") ||
        text.startsWith("*") ||
        text.endsWith("*/")
      )
    )
      break;
    block.unshift(text);
  }
  return block.join(" ");
}

it("class-level maps and sets in replicas say why they may live in memory", () => {
  const unclassified: string[] = [];
  for (const file of SCANNED.flatMap(sources)) {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!COLLECTION.test(line) || !FIELD.test(line)) return;
      if (!MARKER.test(commentAbove(lines, index)))
        unclassified.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(
    unclassified,
    "Classify each per ADR 0193 in a comment right above it, or move it to Postgres",
  ).toEqual([]);
});

it("recognizes the fields it guards", () => {
  expect(
    FIELD.test("  private readonly cache = new Map<string, number>();"),
  ).toBe(true);
  expect(FIELD.test("  private readonly registry: Map<string, Kind>;")).toBe(
    true,
  );
  expect(
    FIELD.test(
      "    private readonly registered: ReadonlySet<string> = new Set(),",
    ),
  ).toBe(true);
  expect(FIELD.test("    const seen = new Set<string>();")).toBe(false);
  expect(
    MARKER.test(commentAbove(["  /** Replica memory (b): by sha. */", "x"], 1)),
  ).toBe(true);
});
