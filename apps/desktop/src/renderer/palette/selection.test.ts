import { expect, it } from "vitest";
import {
  highlightedRow,
  moveHighlight,
  settleSelection,
  TOP_ROW,
} from "./selection.js";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

it("keeps the top result highlighted while nothing was chosen", () => {
  expect(highlightedRow(TOP_ROW, rows("a", "b"))).toBe(0);
  // A late source ranks above: the new top result leads.
  expect(highlightedRow(TOP_ROW, rows("late", "a", "b"))).toBe(0);
  expect(settleSelection(TOP_ROW, rows("late", "a"))).toBe(TOP_ROW);
});

it("keeps a chosen row highlighted when late sources re-rank the list", () => {
  const chosen = moveHighlight(TOP_ROW, rows("a", "b", "c"), 1);
  expect(chosen).toEqual({ index: 1, id: "b" });
  // Two rows arrive above it; Enter must still open "b", not "a".
  const reranked = rows("late", "other", "a", "b", "c");
  expect(highlightedRow(chosen, reranked)).toBe(3);
  expect(settleSelection(chosen, reranked)).toEqual({ index: 3, id: "b" });
  // The next arrow press moves from where the row is now.
  expect(moveHighlight(chosen, reranked, 1)).toEqual({ index: 4, id: "c" });
  expect(moveHighlight(chosen, reranked, -1)).toEqual({ index: 2, id: "a" });
  // Nothing moved: the same selection, so no re-render.
  const settled = { index: 1, id: "b" };
  expect(settleSelection(settled, rows("a", "b"))).toBe(settled);
});

it("gives up a chosen row that leaves the list, and does not jump back to it", () => {
  const chosen = { index: 2, id: "gone" };
  expect(highlightedRow(chosen, rows("a", "b", "c", "d"))).toBe(2);
  const released = settleSelection(chosen, rows("a", "b", "c", "d"));
  expect(released).toEqual({ index: 2, id: null });
  // The row comes back first: the highlight stays at its position.
  expect(highlightedRow(released, rows("gone", "a", "b", "c"))).toBe(2);
  expect(settleSelection(chosen, rows("a"))).toEqual({ index: 0, id: null });
});

it("stops at either end of the list", () => {
  expect(moveHighlight(TOP_ROW, rows("a", "b"), -1)).toEqual({
    index: 0,
    id: "a",
  });
  expect(moveHighlight({ index: 1, id: "b" }, rows("a", "b"), 1)).toEqual({
    index: 1,
    id: "b",
  });
});

it("arrows on an empty list leave the top row highlighted when rows arrive", () => {
  const moved = moveHighlight(TOP_ROW, [], 1);
  expect(moved).toEqual({ index: 0, id: null });
  expect(highlightedRow(moved, rows("a", "b"))).toBe(0);
  expect(highlightedRow(moveHighlight(TOP_ROW, [], -1), rows("a"))).toBe(0);
});
