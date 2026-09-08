import { describe, expect, it } from "vitest";
import { GITHUB_PROJECT_EVENT_TRIGGER_KINDS } from "../github-trigger-kinds.js";

const pullRequest = GITHUB_PROJECT_EVENT_TRIGGER_KINDS.find(
  (kind) => kind.name === "github.pull_request",
);

describe("GitHub Project Event trigger kinds", () => {
  it("ships the complete desktop watcher event roster", () => {
    expect(GITHUB_PROJECT_EVENT_TRIGGER_KINDS.map((kind) => kind.name)).toEqual(
      [
        "github.pull_request",
        "github.pull_request_review",
        "github.check_run",
        "github.check_suite",
        "github.workflow_run",
      ],
    );
  });

  it("validates normalized Project Event envelopes and empty config", () => {
    const event = {
      id: "336b27cb-0288-4c6a-99ee-34bc38c56f91",
      sequence: 42,
      projectId: "a964a8b4-146d-4860-962d-6503d6407fd7",
      source: "github",
      kind: "github.pull_request",
      externalId: "pull_request:1:updated",
      occurredAt: "2026-08-29T08:00:00.000Z",
      receivedAt: "2026-08-29T08:00:01.000Z",
      payload: { action: "updated", number: 1 },
    };
    expect(pullRequest?.validatePayload(event)).toEqual({ ok: true });
    expect(pullRequest?.validatePayload({ ...event, source: "other" }).ok).toBe(
      false,
    );
    expect(pullRequest?.validateConfig({})).toEqual({ ok: true });
    expect(pullRequest?.validateConfig({ action: "opened" }).ok).toBe(false);
    expect(pullRequest?.correlationKey?.(event)).toBe(event.id);
  });
});
