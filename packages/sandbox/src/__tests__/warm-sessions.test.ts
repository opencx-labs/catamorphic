import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type WarmSession, WarmSessions } from "../index.js";

class Session implements WarmSession {
  closed = 0;
  alive = true;
  constructor(readonly name: string) {}
  async close(): Promise<void> {
    this.closed += 1;
    this.alive = false;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("hands a thread's idle session to the next attempt it accepts", async () => {
  const sessions = new WarmSessions<Session>({ idleMs: 1_000, max: 2 });
  const a = new Session("a");
  sessions.release("thread-a", a);
  expect(await sessions.take("thread-a", () => true)).toBe(a);
  // Taken: an attempt uses it now, so nobody else gets it.
  expect(await sessions.take("thread-a", () => true)).toBeUndefined();
  expect(a.closed).toBe(0);
});

it("closes a session the next attempt refuses, or one that died", async () => {
  const sessions = new WarmSessions<Session>({ idleMs: 1_000, max: 2 });
  const refused = new Session("refused");
  sessions.release("thread", refused);
  expect(await sessions.take("thread", () => false)).toBeUndefined();
  expect(refused.closed).toBe(1);

  const dead = new Session("dead");
  sessions.release("thread", dead);
  dead.alive = false;
  expect(await sessions.take("thread", () => true)).toBeUndefined();
});

it("ends idle sessions after idleMs, and the least recently used past max", () => {
  const sessions = new WarmSessions<Session>({ idleMs: 1_000, max: 2 });
  const [a, b, c] = ["a", "b", "c"].map((name) => new Session(name));
  if (!a || !b || !c) throw new Error("three sessions");
  sessions.release("a", a);
  vi.advanceTimersByTime(500);
  sessions.release("b", b);
  sessions.release("c", c);
  expect(a.closed).toBe(1);
  expect(sessions.size).toBe(2);
  vi.advanceTimersByTime(500);
  expect(b.closed).toBe(0);
  vi.advanceTimersByTime(500);
  expect(b.closed).toBe(1);
  expect(c.closed).toBe(1);
  expect(sessions.size).toBe(0);
});

it("forgets a session whose process ended, and disposes the rest", async () => {
  const sessions = new WarmSessions<Session>({ idleMs: 1_000, max: 4 });
  const gone = new Session("gone");
  const kept = new Session("kept");
  sessions.release("gone", gone);
  sessions.release("kept", kept);
  sessions.forget("gone", gone);
  expect(sessions.size).toBe(1);
  await sessions.dispose();
  expect(kept.closed).toBe(1);
  expect(gone.closed).toBe(0);
  // After dispose, a session put back is closed at once.
  const late = new Session("late");
  sessions.release("late", late);
  expect(late.closed).toBe(1);
});
