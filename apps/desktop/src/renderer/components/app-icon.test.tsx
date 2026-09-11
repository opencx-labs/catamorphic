import { APP_ICON_NAMES, resolveAppIcon } from "@catamorphic/app";
import { GitPullRequest, LayoutGrid } from "lucide-react";
import { describe, expect, it } from "vitest";
import { appGlyph } from "./app-icon.js";

describe("canonical app icons", () => {
  it("uses one review glyph and maps every supported type", () => {
    expect(appGlyph("review")).toBe(GitPullRequest);
    expect(new Set(APP_ICON_NAMES.map(appGlyph)).size).toBe(
      APP_ICON_NAMES.length,
    );
  });
  it.each([undefined, null, "", "future-type", "Review", "review:purple"])(
    "retains the current app icon for unknown metadata %s",
    (value) => {
      expect(resolveAppIcon(value)).toBe("default");
      expect(appGlyph(value)).toBe(LayoutGrid);
    },
  );
});
