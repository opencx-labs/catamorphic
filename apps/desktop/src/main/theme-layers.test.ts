import { describe, expect, it } from "vitest";
import { normalizePrefs } from "../shared/app-prefs.js";
import { normalizeThemeLayer, resolveThemeLayers } from "./theme.js";

describe("project theme inheritance", () => {
  it("follows system appearance while fonts and tokens inherit independently", () => {
    const layers = [
      {
        selection: "system",
        fonts: { sans: "Arial, sans-serif", mono: "Monaco, monospace" },
      },
      { fonts: { mono: "Menlo, monospace" }, overrides: { accent: "#123456" } },
    ];
    expect(resolveThemeLayers(layers, "light")).toMatchObject({
      selection: "system",
      preset: "light",
      appearance: "light",
      fonts: { sans: "Arial, sans-serif", mono: "Menlo, monospace" },
      colors: { accent: "#123456" },
    });
    expect(resolveThemeLayers(layers, "dark").preset).toBe("dark");
  });
  it("keeps a one-token edit sparse as its inherited profile changes", () => {
    const personal = normalizeThemeLayer({ overrides: { accent: "#123456" } });
    expect(personal.selection).toBeUndefined();
    const resolved = resolveThemeLayers([
      { selection: "light", overrides: { border: "#345678" } },
      personal,
    ]);
    expect(resolved.preset).toBe("light");
    expect(resolved.colors).toMatchObject({
      accent: "#123456",
      border: "#345678",
    });
  });
  it("inherits profile colors and lets personal tokens win over shared project tokens", () => {
    const resolved = resolveThemeLayers([
      {
        selection: "midnight",
        overrides: { accent: "#112233", border: "#223344" },
      },
      { overrides: { accent: "#334455", fg: "#abcdef" } },
      { overrides: { accent: "#556677" } },
    ]);
    expect(resolved.preset).toBe("midnight");
    expect(resolved.colors).toMatchObject({
      accent: "#556677",
      border: "#223344",
      fg: "#abcdef",
    });
  });
  it("a new preset clears inherited color edits before applying its own edits", () => {
    const resolved = resolveThemeLayers([
      { selection: "dark", overrides: { bg: "#000000", accent: "#112233" } },
      { selection: "light", overrides: { accent: "#abcdef" } },
    ]);
    expect(resolved.colors.bg).toBe("#f7f8fa");
    expect(resolved.colors.accent).toBe("#abcdef");
    expect(resolved.appearance).toBe("light");
  });
  it("missing or invalid layers inherit, and unsafe color text cannot enter CSS", () => {
    const resolved = resolveThemeLayers([
      { selection: "paper" },
      null,
      { overrides: { accent: "red;display:none" } },
    ]);
    expect(resolved.preset).toBe("paper");
    expect(resolved.colors.accent).toBe("#a84e1f");
  });
});

it("normalizes the independent dock settings without changing notification defaults", () => {
  expect(
    normalizePrefs({
      dockMultiProject: true,
      dockDetached: false,
      dockSide: "left",
      dockAlignment: "center",
    }),
  ).toMatchObject({
    dockMultiProject: true,
    dockDetached: false,
    dockSide: "left",
    dockAlignment: "center",
    notificationSounds: true,
  });
  expect(
    normalizePrefs({
      dockSide: "invalid",
      dockDetached: "true",
      dockAlignment: "invalid",
    }),
  ).toMatchObject({
    dockSide: "right",
    dockDetached: false,
    dockAlignment: "edge",
  });
});
