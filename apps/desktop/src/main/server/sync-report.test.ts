import { describe, expect, it } from "vitest";
import { syncReport } from "./sync-report.js";

describe("syncReport", () => {
  it("steers local commits in an attached repository to a pull request", () => {
    const report = syncReport({ status: "ahead" });
    expect(report.status).toBe("ahead");
    expect(report.note).toContain("create_pull_request");
    expect(report.note).toContain("never push");
  });

  it("reports divergence without a rescue branch as nothing pushed", () => {
    const report = syncReport({ status: "diverged" });
    expect(report).not.toHaveProperty("rescueBranch");
    expect(report.note).toContain("Nothing was merged or pushed");
    expect(report.note).toContain("create_pull_request");
  });

  it("names an owned repository's rescue branch", () => {
    expect(
      syncReport({ status: "diverged", rescueBranch: "work/diverged-1" }),
    ).toMatchObject({
      status: "diverged",
      rescueBranch: "work/diverged-1",
      note: expect.stringContaining("work/diverged-1"),
    });
  });

  it("passes routine outcomes through", () => {
    expect(syncReport({ status: "pulled" })).toEqual({ status: "pulled" });
    expect(syncReport({ status: "up-to-date" })).toEqual({
      status: "up-to-date",
    });
  });
});
