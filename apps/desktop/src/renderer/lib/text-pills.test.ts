import { describe, expect, it } from "vitest";
import {
  classifyPastedText,
  pasteName,
  selectionName,
  textStats,
} from "./text-pills.js";

describe("classifyPastedText", () => {
  it("leaves ordinary text native", () => {
    expect(classifyPastedText("hello there")).toEqual({ kind: "native" });
    expect(classifyPastedText("two\nlines")).toEqual({ kind: "native" });
    expect(classifyPastedText("   ")).toEqual({ kind: "native" });
  });
  it("pills big pastes by chars or lines, named from the first line", () => {
    const long = `Title line\n${"x".repeat(2000)}`;
    expect(classifyPastedText(long)).toEqual({
      kind: "pill",
      source: { type: "paste" },
      name: "Title line",
    });
    const many = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
    expect(classifyPastedText(many)).toMatchObject({
      kind: "pill",
      source: { type: "paste" },
    });
  });
  it("pills single-line URLs and paths, not prose containing them", () => {
    expect(classifyPastedText("https://example.com/a?b=1")).toEqual({
      kind: "pill",
      source: { type: "url", url: "https://example.com/a?b=1" },
      name: "https://example.com/a?b=1",
    });
    expect(classifyPastedText("/Users/me/notes/plan.md")).toEqual({
      kind: "pill",
      source: { type: "path", path: "/Users/me/notes/plan.md" },
      name: "plan.md",
    });
    expect(classifyPastedText("src/lib/thing.ts")).toMatchObject({
      source: { type: "path" },
    });
    expect(classifyPastedText("see https://example.com for details")).toEqual({
      kind: "native",
    });
    expect(classifyPastedText("C:\\Users\\me\\file.txt")).toMatchObject({
      source: { type: "path" },
    });
  });
  it("normalizes CRLF before measuring", () => {
    const crlf = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\r\n");
    expect(classifyPastedText(crlf)).toMatchObject({ kind: "pill" });
  });
});

describe("names and stats", () => {
  it("clips long paste names", () => {
    expect(pasteName(`${"a".repeat(60)}\nrest`)).toHaveLength(48);
    expect(pasteName("\n\n  first  real   line\n")).toBe("first real line");
    expect(pasteName("")).toBe("Pasted text");
  });
  it("formats selection names", () => {
    expect(
      selectionName({ filePath: "docs/plan.md", startLine: 12, endLine: 24 }),
    ).toBe("plan.md · 12–24");
    expect(selectionName({ filePath: "a.md", startLine: 3, endLine: 3 })).toBe(
      "a.md · 3",
    );
    expect(selectionName({ filePath: "a.md" })).toBe("a.md");
  });
  it("formats stats", () => {
    expect(textStats("abc")).toBe("3 chars");
    expect(textStats("a\nb")).toBe("3 chars · 2 lines");
    expect(textStats("x".repeat(2100))).toBe("2.1k chars");
    expect(textStats("x".repeat(12000))).toBe("12k chars");
  });
});
