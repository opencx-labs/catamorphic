import { expect, it } from "vitest";
import { parseOptions } from "./options.js";

it("selects harness, model, effort, timeout and independent repeated runs", () => {
  expect(
    parseOptions({
      cwd: "/tmp",
      args: [
        "--live",
        "--harness",
        "claude-code",
        "--model",
        "chosen-model",
        "--effort",
        "high",
        "--timeout",
        "90",
        "--runs",
        "3",
        "--output",
        "evidence",
      ],
    }),
  ).toMatchObject({
    live: true,
    harness: "claude-code",
    model: "chosen-model",
    effort: "high",
    timeoutMs: 90_000,
    runs: 3,
    output: "/tmp/evidence",
  });
});

it("has no hardcoded model and does not opt into provider calls by default", () => {
  const options = parseOptions({ cwd: "/tmp", args: [] });
  expect(options.live).toBe(false);
  expect(options.model).toBeUndefined();
});

it.each([
  ["--harness", "made-up"],
  ["--timeout", "0"],
  ["--timeout", "3601"],
  ["--runs", "0"],
  ["--runs", "1.5"],
  ["--model"],
  ["--effort", "guess"],
  ["--provider", "guess"],
  ["--unknown"],
  ["--harness", "builtin"],
  ["--model", "a", "--model", "b"],
])("refuses malformed options before an agent can run: %j", (...args) => {
  expect(() => parseOptions({ cwd: "/tmp", args })).toThrow();
});
