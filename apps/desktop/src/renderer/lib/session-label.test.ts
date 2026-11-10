import { expect, it } from "vitest";
import { sessionPresentations } from "./session-label.js";

const row = (id: string, title: string, seconds = 0) => ({
  id,
  title,
  icon: "MessageSquare",
  updatedAt: new Date(Date.UTC(2026, 10, 10, 9, 0, seconds)).toISOString(),
  attentionRequired: false,
  visibility: "promoted",
  running: false,
});

it("retains open chat identities outside the recent session page", () => {
  const older = row("older", "Project notes");
  const recent = Array.from({ length: 100 }, (_, index) =>
    row(`recent-${index}`, `Recent ${index}`, index + 1),
  );
  const sessions = sessionPresentations(recent, [], [older], new Set());
  expect(sessions.get("older")?.title).toBe("Project notes");
  expect(sessions.size).toBe(101);
});

it("keeps fresh attention and visibility while following a streamed title", () => {
  // A streamed rename changes title without changing the snapshot timestamp.
  const cached = row("chat", "Live title", 0);
  const recent = row("chat", "Earlier title", 1);
  const attention = {
    ...row("chat", "Earlier title", 2),
    attentionRequired: true,
    visibility: "archived",
    running: true,
  };
  const result = sessionPresentations(
    [recent],
    [attention],
    [cached],
    new Set(["chat"]),
  ).get("chat");
  expect(result).toEqual({ ...attention, title: "Live title" });
});

it("does not replace a newer listed rename or icon with dormant cached fields", () => {
  const cached = row("chat", "Old title", 1);
  const recent = { ...row("chat", "New title", 2), icon: "Rocket" };
  expect(
    sessionPresentations([recent], [], [cached], new Set()).get("chat"),
  ).toEqual(recent);
});
