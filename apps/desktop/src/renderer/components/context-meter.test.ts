import type { TimelineTurn, Turn } from "@catamorphic/react";
import { describe, expect, it } from "vitest";
import { latestContextSnapshot, latestReportedModel } from "./context-meter.js";

function settled(id: string, usage: Record<string, unknown>): TimelineTurn {
  const turn: Turn = {
    id,
    sessionId: "s",
    ordinal: 1,
    status: "completed",
    inputItemId: null,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 1,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: { changedFiles: [], usage },
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  return { key: id, turn, entries: [] };
}

function changed(code: string): TimelineTurn {
  return {
    key: code,
    turn: null,
    entries: [
      {
        kind: "notice",
        item: {
          id: code,
          sessionId: "s",
          turnId: null,
          attemptId: null,
          parentItemId: null,
          position: 1,
          status: "completed",
          nativeRef: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          startedAt: null,
          endedAt: null,
          kind: "notice",
          code,
          text: "Changed",
          data: {},
        },
      },
    ],
  };
}

describe("latestReportedModel", () => {
  it("uses the newest model actually reported by a turn", () => {
    expect(
      latestReportedModel([
        settled("a", { model: "old-model" }),
        settled("b", { model: "current-model" }),
      ]),
    ).toBe("current-model");
  });

  it("ignores turns without a reported model", () => {
    expect(latestReportedModel([settled("a", {})])).toBeNull();
  });

  it.each(["agent_changed", "model_changed"])(
    "does not attribute turns before %s to the new selection",
    (code) => {
      expect(
        latestReportedModel([
          settled("a", { model: "old-model" }),
          changed(code),
        ]),
      ).toBeNull();
    },
  );
});

describe("latestContextSnapshot", () => {
  it("reads the latest turn that reported its context", () => {
    expect(
      latestContextSnapshot([
        settled("a", { contextTokens: 10, contextWindow: 100 }),
        settled("b", {}),
      ]),
    ).toEqual({ usedTokens: 10, windowTokens: 100 });
  });
});
