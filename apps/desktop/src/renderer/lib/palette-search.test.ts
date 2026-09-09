import { expect, it } from "vitest";
import { SETTINGS_CATALOG } from "../../shared/settings-catalog.js";
import { createPaletteIndex, PALETTE_RESULT_LIMIT } from "./palette-search.js";

it("finds individual settings without reading preference values", () => {
  const search = createPaletteIndex(SETTINGS_CATALOG);
  expect(search("tab frame")[0]?.id).toBe("tabFrame");
  expect(search("monospace font")[0]?.id).toBe("theme.fonts.mono");
  expect(search("accent color")[0]?.id).toBe("theme.overrides.accent");
  expect(search("tbfrm").some((item) => item.id === "tabFrame")).toBe(true);
  expect(new Set(SETTINGS_CATALOG.map((item) => item.id)).size).toBe(
    SETTINGS_CATALOG.length,
  );
});
it("bounds results on large indexes, preserves exact matches and refuses pasted prose", () => {
  const items = Array.from({ length: 10000 }, (_, index) => ({
    id: String(index),
    label: `Project resource ${index}`,
    keywords: ["project", "resource"],
  }));
  const search = createPaletteIndex(items);
  expect(search("resource")).toHaveLength(PALETTE_RESULT_LIMIT);
  expect(search("Project resource 9999")[0]?.id).toBe("9999");
  expect(search("a".repeat(10000))).toEqual([]);
  expect(search("line one\nline two")).toEqual([]);
});
