import isNumber from "is-number";

/** An order's total in cents: the sum of its lines' amounts, skipping lines without one. */
export function total(lines) {
  return lines.reduce(
    (sum, line) =>
      isNumber(line.amount) ? sum + Math.round(Number(line.amount) * 100) : sum,
    0,
  );
}
