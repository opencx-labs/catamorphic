import { expect, it } from "vitest";
import { classifyTurnError } from "../adapter.js";

it("retries provider routing discovery after a restart only before any work", () => {
  const error = {
    message:
      "Error running remote compact task: workspace routing discovery failed",
    codexErrorInfo: "other",
  };
  expect(classifyTurnError(error, { workStarted: false })).toEqual({
    message: error.message,
    kind: "unavailable",
    retrySafe: true,
  });
  expect(classifyTurnError(error, { workStarted: true })).toEqual({
    message: error.message,
    kind: "unavailable",
  });
  expect(
    classifyTurnError(
      { message: "thread abc already has an active writer" },
      { workStarted: false },
    ),
  ).toEqual({ message: "thread abc already has an active writer" });
});
