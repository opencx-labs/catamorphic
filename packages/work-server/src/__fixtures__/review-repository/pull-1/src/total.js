import isNumber from "is-number";

/** An order's total: the sum of its lines' amounts, skipping lines without one. */
export function total(lines) {
  return lines.reduce(
    (sum, line) => (isNumber(line.amount) ? sum + Number(line.amount) : sum),
    0,
  );
}
