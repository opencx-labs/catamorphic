import type { Json } from "@catamorphic/db";
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
          key: "slack:C1:1.2",
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
    expect(kind?.validatePayload(payload)).toEqual({ ok: true });
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
  it("takes a request that opened as core records it, selected by agent (ADR 0352)", () => {
    const kind = SESSION_TRIGGER_KINDS.find(
      (entry) => entry.name === "session.request-opened",
    );
    // The envelope core builds for the event (`requestEventInput`): the
    // same one it matches a listening automation against before the
    // database has given the event its sequence.
    const payload = {
      id: "0b6f6a43-1a41-4b62-8f55-6f3c2f7f8d10",
      sequence: 0,
      projectId: "p",
      source: "session",
      kind: "session.request-opened",
      externalId: "2f0c8f2e-3c58-4f39-9a55-0b7d7b2a8f11",
      occurredAt: "2026-11-25T10:00:00.000Z",
      receivedAt: "2026-11-25T10:00:00.000Z",
      payload: {
        sessionId: "s",
        agentId: "project:p:reviewer",
        externalUserId: "catamorphic:project",
        session: {
          id: "s",
          key: null,
          title: "Review #42",
          status: "active",
          workStatus: "open",
          activity: null,
          parentSessionId: "parent",
          stateRevision: 3,
          authorityHostId: "h",
          authorityRevision: 1,
        },
        actor: { kind: "system", code: "session.request-opened" },
        causation: [],
        detail: {
          requestId: "r",
          kind: "approval",
          blocking: true,
          title: "Allow post?",
          description: null,
          origin: { kind: "mcp", id: "connection_github" },
          approval: {
            action: "connection_github · post",
            tool: {
              server: "connection_github",
              name: "post",
              input: { path: "/repos/acme/web/issues" },
            },
          },
          questions: null,
          elicitation: null,
          turnId: "t",
          attemptId: "a",
          expiresAt: null,
        },
      },
    };
    expect(kind?.modes).toEqual(["async"]);
    expect(kind?.validatePayload(payload)).toEqual({ ok: true });
    expect(kind?.matches?.({ config: {}, payload })).toBe(true);
    expect(
      kind?.matches?.({ config: { agentId: "project:p:reviewer" }, payload }),
    ).toBe(true);
    expect(
      kind?.matches?.({ config: { agentId: "project:p:auditor" }, payload }),
    ).toBe(false);
    expect(kind?.matches?.({ config: { sessionId: "other" }, payload })).toBe(
      false,
    );
  });

  it("selects recorded results by name", () => {
    const kind = SESSION_TRIGGER_KINDS.find(
      (entry) => entry.name === "session.result-recorded",
    );
    const payload = {
      id: "event",
      sequence: 2,
      projectId: "p",
      source: "session",
      kind: "session.result-recorded",
      externalId: "event",
      occurredAt: "now",
      receivedAt: "now",
      payload: {
        sessionId: "s",
        agentId: "a",
        externalUserId: "u",
        actor: { kind: "agent" },
        causation: [],
        detail: { name: "review", value: { verdict: "COMMENT" } },
        session: {
          id: "s",
          key: "pr-acme/web-1",
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
    expect(kind?.validatePayload(payload)).toEqual({ ok: true });
    expect(kind?.validateConfig({ names: ["review"] }).ok).toBe(true);
    expect(kind?.matches?.({ config: { names: ["review"] }, payload })).toBe(
      true,
    );
    expect(kind?.matches?.({ config: { names: ["vote"] }, payload })).toBe(
      false,
    );
  });

  it("types a workspace setup's detail, and selects by chat, agent and reason (ADR 0355)", () => {
    const kind = SESSION_TRIGGER_KINDS.find(
      (entry) => entry.name === "session.workspace-setup",
    );
    const event = (detail: Json) => ({
      id: "event",
      sequence: 3,
      projectId: "p",
      source: "session",
      kind: "session.workspace-setup",
      externalId: "event",
      occurredAt: "now",
      receivedAt: "now",
      payload: {
        sessionId: "s",
        agentId: "a",
        externalUserId: "catamorphic:project",
        actor: { kind: "system", code: "session.workspace-setup" },
        causation: [],
        detail,
        session: {
          id: "s",
          key: "pr-acme/web-1",
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
    });
    const kept = event({
      reason: "base-moved",
      environment: "review",
      workspace: { ref: "refs/pull/1/head", commit: "b".repeat(40) },
      previous: { commit: "a".repeat(40) },
      sandbox: "kept",
    });
    const made = event({
      reason: "created",
      environment: "review",
      workspace: { ref: "refs/pull/1/head", commit: "a".repeat(40) },
      previous: null,
      sandbox: "new",
    });
    expect(kind?.modes).toEqual(["async"]);
    for (const payload of [kept, made])
      expect(kind?.validatePayload(payload)).toEqual({ ok: true });
    // What a workflow reads is what the kind promises: nothing is left out.
    expect(kind?.validatePayload(event({ reason: "created" })).ok).toBe(false);
    expect(
      kind?.validatePayload(
        event({
          reason: "created",
          environment: "review",
          workspace: null,
          previous: null,
          sandbox: "new",
        }),
      ).ok,
    ).toBe(false);
    expect(kind?.matches?.({ config: {}, payload: kept })).toBe(true);
    expect(
      kind?.matches?.({
        config: { sessionId: "s", agentId: "a" },
        payload: kept,
      }),
    ).toBe(true);
    expect(
      kind?.matches?.({ config: { agentId: "other" }, payload: kept }),
    ).toBe(false);
    // `statuses` selects reasons.
    expect(
      kind?.matches?.({ config: { statuses: ["base-moved"] }, payload: kept }),
    ).toBe(true);
    expect(
      kind?.matches?.({ config: { statuses: ["base-moved"] }, payload: made }),
    ).toBe(false);
  });
});
