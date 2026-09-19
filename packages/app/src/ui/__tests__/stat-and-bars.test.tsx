import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { APP_KIT_CSS } from "../../kit-css.js";
import { BarList } from "../bar-list.js";
import { Stat } from "../stat.js";

describe("Stat", () => {
  it("stacks label, value and a toned detail line", () => {
    const { container } = render(
      <Stat
        label="Chats this week"
        value={14}
        detail="+3 vs last week"
        tone="success"
      />,
    );
    expect(container.querySelector(".cat-stat-label")?.textContent).toBe(
      "Chats this week",
    );
    expect(container.querySelector(".cat-stat-value")?.textContent).toBe("14");
    expect(
      container.querySelector(".cat-stat-detail--success")?.textContent,
    ).toBe("+3 vs last week");
  });
});

describe("BarList", () => {
  it("scales bars to the largest value and formats the shown value", () => {
    const { container } = render(
      <BarList
        items={[
          { key: "mon", label: "Monday", value: 4 },
          { key: "tue", label: "Tuesday", value: 8 },
          { key: "wed", label: "Wednesday", value: 0 },
        ]}
        format={(value) => `${value} chats`}
      />,
    );
    const fills = [...container.querySelectorAll<HTMLElement>(".cat-bar-fill")];
    expect(fills.map((fill) => fill.style.width)).toEqual([
      "50%",
      "100%",
      "0%",
    ]);
    expect(container.querySelector(".cat-bar-value")?.textContent).toBe(
      "4 chats",
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("turns rows into buttons when a selection handler exists", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <BarList
        items={[{ key: "a", label: "A", value: 1 }]}
        onSelect={onSelect}
      />,
    );
    const row = container.querySelector("button");
    expect(row).toBeTruthy();
    if (row) fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("colors bars from the theme tokens, never a literal", () => {
    const bars = APP_KIT_CSS.slice(
      APP_KIT_CSS.indexOf("bar list"),
      APP_KIT_CSS.indexOf("tabs */"),
    );
    expect(bars).toMatch(/--color-accent/);
    expect(bars).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
