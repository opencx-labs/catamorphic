import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Calendar } from "../calendar.js";
import { todayIso } from "../dates.js";

const month = todayIso().slice(0, 7);
const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`;

/** The in-month day button showing `d` (outside days are marked). */
function dayButton(d: number): HTMLButtonElement {
  const match = screen
    .getAllByRole("gridcell")
    .find(
      (cell) =>
        cell.textContent === String(d) && !cell.hasAttribute("data-outside"),
    );
  if (!match) throw new Error(`no in-month day ${d}`);
  return match as HTMLButtonElement;
}

describe("Calendar range selection", () => {
  it("does not commit a 1-day range on the first click", () => {
    const onSelect = vi.fn();
    render(<Calendar mode="range" value={null} onSelect={onSelect} />);
    fireEvent.click(dayButton(15));
    // First click: start chosen, end pending — nothing committed.
    expect(onSelect).not.toHaveBeenCalled();
    expect(dayButton(15)).toHaveAttribute("data-range-start", "true");
    fireEvent.click(dayButton(18));
    expect(onSelect).toHaveBeenCalledWith({ from: day(15), to: day(18) });
  });

  it("restarts the range when the second click lands before the start", () => {
    const onSelect = vi.fn();
    render(<Calendar mode="range" value={null} onSelect={onSelect} />);
    fireEvent.click(dayButton(15));
    fireEvent.click(dayButton(10)); // before the start: restart, still pending
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(dayButton(12));
    expect(onSelect).toHaveBeenCalledWith({ from: day(10), to: day(12) });
  });

  it("commits a deliberate 1-day range on a second click of the same day", () => {
    const onSelect = vi.fn();
    render(<Calendar mode="range" value={null} onSelect={onSelect} />);
    fireEvent.click(dayButton(15));
    fireEvent.click(dayButton(15));
    expect(onSelect).toHaveBeenCalledWith({ from: day(15), to: day(15) });
  });
});

describe("Calendar keyboard navigation", () => {
  it("moves REAL focus and auto-switches the month across boundaries", () => {
    render(<Calendar value="2026-08-01" onSelect={() => {}} />);
    expect(screen.getByRole("grid")).toHaveAccessibleName("August 2026");
    const first = dayButton(1);
    expect(first).toHaveAttribute("tabindex", "0"); // roving tab stop
    first.focus();
    // ArrowLeft from Aug 1 lands on Jul 31: the visible month follows and
    // the freshly mounted day button takes actual DOM focus.
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("grid")).toHaveAccessibleName("July 2026");
    const july31 = dayButton(31);
    expect(document.activeElement).toBe(july31);
    expect(july31).toHaveAttribute("tabindex", "0");
  });

  it("supports PageDown month jumps and Home/End week ends", () => {
    render(<Calendar value="2026-08-12" onSelect={() => {}} />);
    const start = dayButton(12);
    start.focus();
    fireEvent.keyDown(start, { key: "PageDown" });
    expect(screen.getByRole("grid")).toHaveAccessibleName("September 2026");
    expect(document.activeElement?.textContent).toBe("12");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    // 2026-09-12 is a Saturday; Home goes to Sunday the 6th.
    expect(document.activeElement?.textContent).toBe("6");
  });
});
