import { expect, it } from "vitest";
import { sanitizePresentation } from "../../shared/source-rows.js";
import { sparklinePaths } from "./sparkline.js";

it("draws the latest reading at the right edge, a short history starting partway", () => {
  const { line, area } = sparklinePaths([0, 1]);
  // Thirty slots across 36px: two readings take the last step.
  expect(line).toBe("M34.76,13.00L36.00,1.00");
  expect(area).toBe("M34.76,13.00L36.00,1.00L36,14L34.76,14Z");
  expect(sparklinePaths([]).line).toBe("");
});

it("keeps a full history inside the box, clamping what overflows", () => {
  const { line } = sparklinePaths(
    Array.from({ length: 40 }, (_, index) => (index % 2 ? 3 : -1)),
  );
  expect(line.startsWith("M0.00,")).toBe(true);
  expect(line).not.toMatch(/-\d/);
});

it("bounds a source's trend: sixty readings from 0 through 1, a short label", () => {
  const presentation = sanitizePresentation({
    trend: {
      values: [
        ...Array.from({ length: 70 }, () => 0.5),
        2,
        -1,
        "x",
        Number.NaN,
      ],
      label: "a very long label indeed",
      tone: "danger",
    },
  });
  expect(presentation.trend?.values).toHaveLength(60);
  expect(presentation.trend?.values.slice(-2)).toEqual([1, 0]);
  expect(presentation.trend?.label).toBe("a very long labe");
  expect(presentation.trend?.tone).toBe("danger");
  expect(sanitizePresentation({ trend: { values: [] } }).trend).toBeUndefined();
});
