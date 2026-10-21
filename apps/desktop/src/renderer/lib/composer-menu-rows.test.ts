// @vitest-environment jsdom

import { Sparkles } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  type ComposerMenuRow,
  firstPickable,
  humanizeName,
  namedBy,
  skillMention,
  splitPath,
  stepPickable,
} from "./composer-menu-rows";

const row = (
  id: string,
  label: string,
  extra: Partial<ComposerMenuRow> = {},
): ComposerMenuRow => ({
  id,
  icon: Sparkles,
  label,
  keywords: [],
  pick: { kind: "retry" },
  ...extra,
});

describe("composer menu rows", () => {
  it("reads a command's name as a label", () => {
    expect(humanizeName("compact")).toBe("Compact");
    expect(humanizeName("pr-review")).toBe("Pr review");
    expect(humanizeName("release_notes")).toBe("Release notes");
  });

  it("matches a mid-message word by name or label only", () => {
    const review = row("skill:code-review", "Code review", {
      detail: "Find bugs in temporary files",
    });
    expect(namedBy(review, "rev")).toBe(true);
    expect(namedBy(review, "code-r")).toBe(true);
    // A description mentioning it is not enough: "/tmp" is a path.
    expect(namedBy(review, "tmp")).toBe(false);
    expect(namedBy(row("action:archive-chat", "Archive chat"), "arch")).toBe(
      true,
    );
  });

  it("splits a mentioned path into its name and folder", () => {
    expect(splitPath("src/lib/menu.ts")).toEqual({
      name: "menu.ts",
      parent: "src/lib",
    });
    expect(splitPath("src/lib/")).toEqual({ name: "lib", parent: "src" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", parent: "" });
  });

  it("skips rows that cannot be picked, wrapping at either end", () => {
    const rows = [
      row("a", "A"),
      row("loading", "Loading", { disabled: true }),
      row("b", "B"),
    ];
    expect(firstPickable(rows, 0)).toBe(0);
    expect(firstPickable(rows, 1)).toBe(2);
    expect(firstPickable([row("x", "X", { disabled: true })], 0)).toBe(-1);
    expect(stepPickable(rows, 0, 1)).toBe(2);
    expect(stepPickable(rows, 2, 1)).toBe(0);
    expect(stepPickable(rows, 0, -1)).toBe(2);
    expect(stepPickable([], 0, 1)).toBe(-1);
  });

  it("makes a skill a pill the agent reads as the skill", () => {
    expect(
      skillMention({
        name: "team-notes",
        title: "Team notes",
        description: "",
        source: "Project skill",
        argumentHint: "",
        kind: "skill",
      }),
    ).toEqual({
      kind: "text",
      name: "Team notes",
      text: 'Use the "team-notes" skill.',
      source: { type: "skill", name: "team-notes" },
    });
    // A harness's own skill names its file.
    expect(
      skillMention({
        name: "native-notes",
        title: "native-notes",
        description: "",
        source: "Codex skill",
        argumentHint: "",
        kind: "skill",
        skillPath: "/s/native-notes/SKILL.md",
      }).source,
    ).toEqual({
      type: "skill",
      name: "native-notes",
      path: "/s/native-notes/SKILL.md",
    });
  });
});
