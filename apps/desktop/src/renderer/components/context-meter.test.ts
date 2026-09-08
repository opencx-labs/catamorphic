import { describe, expect, it } from "vitest";
import { latestReportedModel } from "./context-meter.js";

describe("latestReportedModel", () => {
  it("uses the newest model actually reported by an assistant turn", () => {
    expect(
      latestReportedModel([
        { role: "assistant", metadata: { usage: { model: "old-model" } } },
        { role: "user" },
        { role: "assistant", metadata: { usage: { model: "current-model" } } },
      ]),
    ).toBe("current-model");
  });

  it("ignores missing and malformed usage data", () => {
    expect(
      latestReportedModel([
        { role: "assistant", metadata: { usage: { model: 42 } } },
      ]),
    ).toBeNull();
  });

  it.each(["agent_change", "model_change"])(
    "does not attribute replies before %s to the new selection",
    (kind) => {
      expect(
        latestReportedModel([
          { role: "assistant", metadata: { usage: { model: "old-model" } } },
          { role: "system", metadata: { marker: { kind } } },
        ]),
      ).toBeNull();
    },
  );
});
