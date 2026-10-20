// @vitest-environment jsdom

import { Sparkles } from "lucide-react";
import { describe, expect, it } from "vitest";
import { EMPTY_PALETTE_SIGNALS } from "../../shared/palette.js";
import { recentFirst } from "./load.js";
import { composerText, skillTarget } from "./modes/skills.js";
import type { PaletteItem } from "./types.js";

const row = (name: string): PaletteItem => ({
  id: `skills:${name}`,
  icon: Sparkles,
  label: name,
  keywords: [],
  kind: "navigate",
  usage: `skill:${name}`,
  run: () => {},
});

describe("skills in the palette", () => {
  it("applies a skill to the chat in front, or starts one", () => {
    expect(skillTarget("replace", true)).toBe("chat");
    expect(skillTarget("replace", false)).toBe("float");
    expect(skillTarget("tab", true)).toBe("tab");
    expect(skillTarget("side", true)).toBe("tab");
    expect(skillTarget("floating", true)).toBe("float");
  });

  it("hands a dismissed composer back what was typed after its slash", () => {
    expect(composerText("skills", "")).toBe("/");
    expect(composerText("skills", "usr/bin is missing")).toBe(
      "/usr/bin is missing",
    );
    expect(composerText("skill:review", "the auth change")).toBe(
      "/review the auth change",
    );
    expect(composerText(null, "")).toBe("/");
  });

  it("opens with the most used skills under Recent, then the rest", () => {
    const rows = ["alpha", "beta", "gamma"].map(row);
    expect(recentFirst(rows, { signals: EMPTY_PALETTE_SIGNALS })).toEqual(rows);
    const ordered = recentFirst(rows, {
      signals: {
        ...EMPTY_PALETTE_SIGNALS,
        usage: {
          "skill:gamma": { frecency: 4 },
          "skill:beta": { frecency: 1 },
        },
      },
    });
    expect(ordered.map((item) => [item.label, item.group])).toEqual([
      ["gamma", "Recent"],
      ["beta", "Recent"],
      ["alpha", "All"],
    ]);
  });
});
