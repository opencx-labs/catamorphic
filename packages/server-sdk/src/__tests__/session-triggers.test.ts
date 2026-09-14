import { describe, expect, it } from "vitest";
import { schedule } from "../schedule-trigger-kind.js";
import { SESSION_TRIGGER_KINDS } from "../session-trigger-kinds.js";

describe("session workflow trigger contracts", () => {
  it("accepts the real scheduler payload and exclusive clock configurations", () => {
    expect(
      schedule.validatePayload({
        activationId: "00000000-0000-4000-8000-000000000001",
        scheduledFor: "2026-09-14T12:00:00Z",
        firedAt: "2026-09-14T12:00:00Z",
      }),
    ).toEqual({ ok: true });
    expect(schedule.validateConfig({ at: "invalid" }).ok).toBe(false);
    expect(
      schedule.validateConfig({
        at: "2026-09-14T12:00:00Z",
        cron: "* * * * *",
        timezone: "UTC",
      }).ok,
    ).toBe(false);
    expect(
      schedule.validateConfig({ cron: "* * * * *", timezone: "Invalid/Zone" })
        .ok,
    ).toBe(false);
    expect(
      schedule.validateConfig({ at: "2026-09-14T15:00:00+03:00" }).ok,
    ).toBe(true);
  });
  it("matches optional session, agent, state and turn status selectors", () => {
    const kind = SESSION_TRIGGER_KINDS.find(
      (entry) => entry.name === "session.turn-changed",
    );
    const payload = {
      id: "event",
      sequence: 1,
      projectId: "p",
      source: "session",
      kind: "session.turn-changed",
      externalId: "event",
      occurredAt: "now",
      receivedAt: "now",
      payload: {
        sessionId: "s",
        agentId: "a",
        externalUserId: "u",
        actor: {},
        causation: [],
        detail: { status: "completed" },
        session: {
          id: "s",
          title: null,
          status: "active",
          workStatus: "open",
          activity: null,
          parentSessionId: null,
          stateRevision: 1,
          authorityHostId: "h",
          authorityRevision: 1,
        },
      },
    };
    expect(kind?.matches?.({ config: {}, payload })).toBe(true);
    expect(
      kind?.matches?.({
        config: { sessionId: "s", agentId: "a", statuses: ["completed"] },
        payload,
      }),
    ).toBe(true);
    expect(kind?.matches?.({ config: { sessionId: "other" }, payload })).toBe(
      false,
    );
    expect(
      kind?.matches?.({ config: { statuses: ["running"] }, payload }),
    ).toBe(false);
    expect(
      kind?.matches?.({ config: { workStatus: "completed" }, payload }),
    ).toBe(false);
  });
});
