import type { SessionEvent } from "@catamorphic/agent-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reply,
  toolCall,
  turn,
} from "../../renderer/components/catamorphic/timeline-fixtures.js";
import { SessionNotes } from "./session-notes.js";

const FOLLOWER = { projectId: "p", sessionId: "assistant" };
const FOLLOWED = { projectId: "p", sessionId: "build" };

function harness() {
  const delivered: { content: string; notice: string }[] = [];
  let send: ((events: SessionEvent[]) => void) | undefined;
  let stopped = 0;
  let sequence = 0;
  const notes = new SessionNotes({
    sequence: async () => 7,
    subscribe: async (_ref, input) => {
      expect(input.after).toBe(7);
      send = (events) =>
        input.send({
          type: "events",
          events: events.map((event) => ({
            sessionId: FOLLOWED.sessionId,
            sequence: ++sequence,
            at: "2026-10-10T10:00:00.000Z",
            commandId: null,
            event,
          })),
        });
      return () => {
        stopped++;
      };
    },
    deliver: async (_follower, input) => {
      delivered.push({ content: input.content, notice: input.notice });
    },
  });
  return {
    notes,
    delivered,
    stopped: () => stopped,
    emit: (...events: SessionEvent[]) => send?.(events),
  };
}

describe("following a session's notes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes on what it writes along the way, a few notes at a time", async () => {
    const session = harness();
    await session.notes.follow({
      follower: FOLLOWER,
      followed: FOLLOWED,
      title: "Build",
      reportsResults: false,
    });
    session.emit(
      { type: "item.added", item: reply("m1", "t1", "Reading the config.") },
      { type: "item.added", item: toolCall("c1", "t1") },
      { type: "item.added", item: reply("m2", "t1", "Found the bug.") },
      { type: "item.added", item: toolCall("c2", "t1") },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.delivered).toEqual([
      {
        content:
          "Build, while it works:\n- Reading the config.\n- Found the bug.",
        notice: "Build: 2 updates",
      },
    ]);
  });

  it("keeps a turn's last message to itself: that is the result", async () => {
    const session = harness();
    await session.notes.follow({
      follower: FOLLOWER,
      followed: FOLLOWED,
      title: "Build",
      reportsResults: false,
    });
    session.emit(
      { type: "item.added", item: reply("m1", "t1", "All fixed.") },
      { type: "turn.changed", turn: turn("t1", 1, { status: "completed" }) },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.delivered).toEqual([]);
  });

  it("tells a follower how a chat it did not start turned out", async () => {
    const session = harness();
    await session.notes.follow({
      follower: FOLLOWER,
      followed: FOLLOWED,
      title: "Build",
      reportsResults: true,
    });
    // A message still being written is no note until it is finished.
    const writing = reply("m1", "t1", "Running the tests.", {
      status: "in_progress",
    });
    session.emit(
      { type: "item.added", item: writing },
      { type: "item.changed", item: { ...writing, status: "completed" } },
      { type: "item.added", item: toolCall("c1", "t1") },
      { type: "item.added", item: reply("m2", "t1", "All green.") },
      { type: "turn.changed", turn: turn("t1", 1, { status: "completed" }) },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(session.delivered).toEqual([
      {
        content:
          "Build finished. Along the way:\n- Running the tests.\n\nIts answer:\nAll green.",
        notice: "Build: finished",
      },
    ]);
  });

  it("follows no more once the follower takes no messages", async () => {
    const stopped: string[] = [];
    const notes = new SessionNotes({
      sequence: async () => 0,
      subscribe: async (_ref, input) => {
        input.send({
          type: "events",
          events: [
            { type: "item.added", item: reply("m1", "t1", "Done.") } as const,
            {
              type: "turn.changed",
              turn: turn("t1", 1, { status: "completed" }),
            } as const,
          ].map((event, index) => ({
            sessionId: FOLLOWED.sessionId,
            sequence: index + 1,
            at: "2026-10-10T10:00:00.000Z",
            commandId: null,
            event,
          })),
        });
        return () => stopped.push("stopped");
      },
      deliver: async () => {
        throw new Error("closed");
      },
    });
    await notes.follow({
      follower: FOLLOWER,
      followed: FOLLOWED,
      title: "Build",
      reportsResults: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(notes.followerOf(FOLLOWED.sessionId)).toBeUndefined();
    expect(stopped).toEqual(["stopped"]);
  });

  it("leaves nothing behind when following fails", async () => {
    const notes = new SessionNotes({
      sequence: async () => {
        throw new Error("gone");
      },
      subscribe: async () => () => {},
      deliver: async () => null,
    });
    await expect(
      notes.follow({
        follower: FOLLOWER,
        followed: FOLLOWED,
        title: "Build",
        reportsResults: true,
      }),
    ).rejects.toThrow("gone");
    expect(notes.followerOf(FOLLOWED.sessionId)).toBeUndefined();
  });

  it("waits between messages, and stops when unfollowed", async () => {
    const session = harness();
    await session.notes.follow({
      follower: FOLLOWER,
      followed: FOLLOWED,
      title: "Build",
      reportsResults: false,
    });
    session.emit(
      { type: "item.added", item: reply("m1", "t1", "First.") },
      { type: "item.added", item: toolCall("c1", "t1") },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    session.emit(
      { type: "item.added", item: reply("m2", "t1", "Second.") },
      { type: "item.added", item: toolCall("c2", "t1") },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.delivered.at(-1)?.notice).toBe("Build: an update");
    session.notes.unfollow(FOLLOWED.sessionId);
    expect(session.stopped()).toBe(1);
    expect(session.notes.followerOf(FOLLOWED.sessionId)).toBeUndefined();
  });
});
