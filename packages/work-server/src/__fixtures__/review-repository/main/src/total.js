/** An order's total: the sum of its lines' amounts. */
export function total(lines) {
  return lines.reduce((sum, line) => sum + line.amount, 0);
}
