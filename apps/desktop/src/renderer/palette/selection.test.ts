import { expect, it } from "vitest";
import { highlightedRow, moveHighlight, TOP_ROW } from "./selection.js";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

it("keeps the top result highlighted while nothing was chosen", () => {
  expect(highlightedRow(TOP_ROW, rows("a", "b"))).toBe(0);
  // A late source ranks above: the new top result leads.
  expect(highlightedRow(TOP_ROW, rows("late", "a", "b"))).toBe(0);
});

it("keeps a chosen row highlighted when late sources re-rank the list", () => {
  const chosen = moveHighlight(TOP_ROW, rows("a", "b", "c"), 1);
  expect(chosen).toEqual({ index: 1, id: "b" });
  // Two rows arrive above it; Enter must still open "b", not "a".
  const reranked = rows("late", "other", "a", "b", "c");
  expect(highlightedRow(chosen, reranked)).toBe(3);
  // The next arrow press moves from where the row is now.
  expect(moveHighlight(chosen, reranked, 1)).toEqual({ index: 4, id: "c" });
  expect(moveHighlight(chosen, reranked, -1)).toEqual({ index: 2, id: "a" });
});

it("falls back to the position when the chosen row leaves the list", () => {
  const chosen = { index: 2, id: "gone" };
  expect(highlightedRow(chosen, rows("a", "b", "c", "d"))).toBe(2);
  expect(highlightedRow(chosen, rows("a"))).toBe(0);
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
