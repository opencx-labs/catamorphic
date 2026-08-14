import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../data-table.js";

interface Row {
  name: string;
  total: number;
}

const rows: Row[] = [
  { name: "Charlie", total: 3 },
  { name: "Alice", total: 20 },
  { name: "Bob", total: 1 },
];

function renderedNames(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1) // header row
    .map((row) => row.querySelector("td")?.textContent ?? "");
}

describe("DataTable sorting", () => {
  it("cycles asc/desc with aria-sort announced", () => {
    render(
      <DataTable<Row>
        columns={[
          { key: "name", header: "Name", sortable: true },
          { key: "total", header: "Total", align: "right", sortable: true },
        ]}
        rows={rows}
        rowKey={(row) => row.name}
      />,
    );
    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    // Unsorted: source order, no aria-sort.
    expect(nameHeader).not.toHaveAttribute("aria-sort");
    expect(renderedNames()).toEqual(["Charlie", "Alice", "Bob"]);
    // First click: ascending.
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect(renderedNames()).toEqual(["Alice", "Bob", "Charlie"]);
    // Second click: descending.
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    expect(renderedNames()).toEqual(["Charlie", "Bob", "Alice"]);
    // Sorting another column moves aria-sort there, numeric compare.
    fireEvent.click(screen.getByRole("button", { name: /Total/ }));
    expect(nameHeader).not.toHaveAttribute("aria-sort");
    expect(screen.getByRole("columnheader", { name: /Total/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(renderedNames()).toEqual(["Bob", "Charlie", "Alice"]);
  });

  it("renders skeleton rows while loading and the quiet empty state", () => {
    const { container, rerender } = render(
      <DataTable<Row>
        columns={[{ key: "name", header: "Name" }]}
        rows={[]}
        loading
      />,
    );
    expect(container.querySelectorAll(".cat-skeleton").length).toBeGreaterThan(
      0,
    );
    rerender(
      <DataTable<Row>
        columns={[{ key: "name", header: "Name" }]}
        rows={[]}
        empty="No orders yet."
      />,
    );
    expect(container.querySelectorAll(".cat-skeleton")).toHaveLength(0);
    expect(screen.getByText("No orders yet.")).toBeInTheDocument();
  });

  it("marks truncated lists with a muted footer row", () => {
    render(
      <DataTable<Row>
        columns={[{ key: "name", header: "Name" }]}
        rows={rows}
        truncated
      />,
    );
    expect(screen.getByText("Showing first 3")).toBeInTheDocument();
  });
});
