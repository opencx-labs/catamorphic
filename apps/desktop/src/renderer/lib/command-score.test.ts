import { expect, it } from "vitest";
import {
  commandScore,
  prepareCommand,
  scorePreparedCommand,
} from "./command-score.js";

it("scores a prepared query whose whitespace was collapsed", () => {
  const command = prepareCommand("Framed content");
  for (const query of ["frmd  co", "frmd\t\tco", "frmd -co"]) {
    const result = scorePreparedCommand(command, query, "frmd co");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  }
});

it("matches the complete normalized query when lowercasing expands Unicode", () => {
  expect(commandScore("İxx", "İxx")).toBeGreaterThan(0);
  expect(commandScore("İxx", "İxy")).toBe(0);
  expect(commandScore("i", "İ")).toBe(0);
  expect(commandScore("İ", "i")).toBeLessThan(1);
});

it("preserves exact matches, case preference and transposed typos", () => {
  expect(commandScore("stock", "stock")).toBe(1);
  expect(commandScore("stock", "stock")).toBeGreaterThan(
    commandScore("Stock", "stock"),
  );
  expect(commandScore("stock", "sotck")).toBeGreaterThan(0);
  expect(commandScore("stock", "unrelated")).toBe(0);
});
