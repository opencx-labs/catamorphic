import { expect, it } from "vitest";
import { cpuSeconds, processTree } from "./desktop-soak.js";

it("accounts for CPU clocks beyond one hour and follows only this app's descendants", () => {
  expect(cpuSeconds("1-01:02:03.50")).toBe(90123.5);
  expect(cpuSeconds("02:03.50")).toBe(123.5);
  expect(
    processTree("1 0 10 0:01\n3 2 30 0:03\n2 1 20 0:02\n8 7 80 0:08", 1).map(
      (p) => p.pid,
    ),
  ).toEqual([1, 3, 2]);
});
