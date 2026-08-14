import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { APP_KIT_CSS } from "../../kit-css.js";
import { AnimatedList } from "../animated-list.js";

type Todo = { id: string; label: string };

function List({ items }: { items: Todo[] }) {
  return (
    <AnimatedList
      items={items}
      getKey={(todo) => todo.id}
      renderItem={(todo) => <span>{todo.label}</span>}
    />
  );
}

const rowOf = (label: string) =>
  screen.getByText(label).closest("li") as HTMLElement;

describe("AnimatedList", () => {
  it("renders the initial items without an enter animation", () => {
    render(<List items={[{ id: "a", label: "Milk" }]} />);
    const row = rowOf("Milk");
    expect(row).not.toHaveClass("cat-row-enter");
    expect(row).not.toHaveClass("cat-row-exit");
  });

  it("animates added rows in", () => {
    const { rerender } = render(<List items={[{ id: "a", label: "Milk" }]} />);
    rerender(
      <List
        items={[
          { id: "a", label: "Milk" },
          { id: "b", label: "Eggs" },
        ]}
      />,
    );
    expect(rowOf("Milk")).not.toHaveClass("cat-row-enter");
    expect(rowOf("Eggs")).toHaveClass("cat-row-enter");
  });

  it("animates removed rows out BEFORE unmount, in place", () => {
    const { rerender } = render(
      <List
        items={[
          { id: "a", label: "Milk" },
          { id: "b", label: "Eggs" },
          { id: "c", label: "Bread" },
        ]}
      />,
    );
    rerender(
      <List
        items={[
          { id: "a", label: "Milk" },
          { id: "c", label: "Bread" },
        ]}
      />,
    );
    // The departing row is still rendered — at its old index, exiting,
    // hidden from assistive tech.
    const row = rowOf("Eggs");
    expect(row).toHaveClass("cat-row-exit");
    expect(row).toHaveAttribute("aria-hidden", "true");
    const rows = screen.getAllByRole("listitem", { hidden: true });
    expect(rows.map((node) => node.textContent)).toEqual([
      "Milk",
      "Eggs",
      "Bread",
    ]);
    // …and leaves the DOM on animationend.
    fireEvent.animationEnd(row);
    expect(screen.queryByText("Eggs")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("falls back to a clock when animation events never arrive", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <List items={[{ id: "a", label: "Milk" }]} />,
      );
      rerender(<List items={[]} />);
      expect(screen.getByText("Milk")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(300)); // occluded windows throttle animation events
      expect(screen.queryByText("Milk")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores animationend bubbling up from row content", () => {
    const { rerender } = render(
      <List
        items={[
          { id: "a", label: "Milk" },
          { id: "b", label: "Eggs" },
        ]}
      />,
    );
    rerender(<List items={[{ id: "a", label: "Milk" }]} />);
    fireEvent.animationEnd(screen.getByText("Eggs"));
    expect(screen.getByText("Eggs")).toBeInTheDocument();
  });

  it("shows fresh item data for live rows on the same render", () => {
    const { rerender } = render(<List items={[{ id: "a", label: "Milk" }]} />);
    rerender(
      <List
        items={[
          { id: "a", label: "Oat milk" },
          { id: "b", label: "Eggs" },
        ]}
      />,
    );
    expect(screen.getByText("Oat milk")).toBeInTheDocument();
    expect(screen.queryByText("Milk")).toBeNull();
  });
});

describe("motion utilities", () => {
  it("ships the enter/exit classes on the host's motion tokens", () => {
    for (const cls of [
      ".cat-anim-enter",
      ".cat-anim-exit",
      ".cat-row-enter",
      ".cat-row-exit",
    ]) {
      expect(APP_KIT_CSS).toContain(cls);
    }
    // Exits hold their final frame for exit-then-remove.
    expect(APP_KIT_CSS).toMatch(/cat-anim-out[^}]*forwards/);
    expect(APP_KIT_CSS).toMatch(/cat-row-out[^}]*forwards/);
  });

  it("covers the utilities under prefers-reduced-motion", () => {
    const reduced = APP_KIT_CSS.slice(
      APP_KIT_CSS.indexOf("prefers-reduced-motion"),
    );
    for (const cls of [
      ".cat-anim-enter",
      ".cat-anim-exit",
      ".cat-row-enter",
      ".cat-row-exit",
    ]) {
      expect(reduced).toContain(cls);
    }
  });
});
