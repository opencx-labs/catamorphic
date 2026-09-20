import { icons } from "lucide-react";
import { describe, expect, it } from "vitest";
import { lucideIcon } from "./lucide-icon.js";

describe("lucideIcon", () => {
  it("resolves canonical and alias names to the same icon", () => {
    expect(lucideIcon("Rocket")).toBe(icons.Rocket);
    expect(lucideIcon("MessageCircleQuestion")).toBe(
      icons.MessageCircleQuestionMark,
    );
    expect(lucideIcon("RocketIcon")).toBe(icons.Rocket);
  });

  it("resolves nothing for unknown names and non-icon exports", () => {
    expect(lucideIcon(undefined)).toBeUndefined();
    expect(lucideIcon("")).toBeUndefined();
    expect(lucideIcon("NoSuchIconName")).toBeUndefined();
    expect(lucideIcon("Icon")).toBeUndefined();
    expect(lucideIcon("LucideProvider")).toBeUndefined();
    expect(lucideIcon("createLucideIcon")).toBeUndefined();
    expect(lucideIcon("icons")).toBeUndefined();
  });
});
