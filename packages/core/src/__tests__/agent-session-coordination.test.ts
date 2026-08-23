import { describe, expect, it } from "vitest";
import { summarizeSessionTask } from "../services/agent-sessions-service.js";

describe("agent session coordination", () => {
  it("summarizes the latest request without leaking an unbounded prompt", () => {
    const request = `  Prepare   the Globex renewal deck\n\n${"with supporting evidence ".repeat(20)}`;

    const summary = summarizeSessionTask(request);

    if (!summary) throw new Error("expected a summary");
    expect(summary).toHaveLength(240);
    expect(summary.startsWith("Prepare the Globex renewal deck with")).toBe(
      true,
    );
    expect(summary.endsWith("…")).toBe(true);
  });

  it("returns null when a request has no visible content", () => {
    expect(summarizeSessionTask(" \n\t ")).toBeNull();
  });
});
