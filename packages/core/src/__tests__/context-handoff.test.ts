import type { Item, ItemCommon } from "@catamorphic/agent-protocol";
import { expect, it } from "vitest";
import { renderTurn } from "../services/sessions/context-handoff.js";

let position = 0;
function common(): ItemCommon {
  position += 1;
  return {
    id: `item-${position}`,
    sessionId: "session",
    turnId: "turn",
    attemptId: "attempt",
    parentItemId: null,
    position,
    status: "completed",
    nativeRef: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
  };
}
const ran = (command: string): Item => ({
  ...common(),
  kind: "command",
  command,
  description: null,
  output: "",
  exitCode: 0,
});
const changed = (path: string): Item => ({
  ...common(),
  kind: "file_change",
  path,
  change: "modified",
  previousPath: null,
});
const said = (text: string): Item => ({
  ...common(),
  kind: "assistant_message",
  text,
  agentId: null,
});

it("tells a turn's words in full, counts its commands, and names each changed file once", () => {
  const text = renderTurn(6, [
    said("Looking into it."),
    ...Array.from({ length: 140 }, (_, index) => ran(`grep step-${index}`)),
    changed("src/a.ts"),
    changed("src/a.ts"),
    changed("src/b.ts"),
    ran("bun run lint"),
    ran("bun run typecheck"),
    ran("bun run test"),
    said("Done: tests pass."),
  ]);
  expect(text.split("\n")).toEqual([
    "Turn 6",
    "Agent: Looking into it.",
    "- changed src/a.ts",
    "- changed src/b.ts",
    "- ran 143 commands; the last 3:",
    "- ran `bun run lint` (exit 0)",
    "- ran `bun run typecheck` (exit 0)",
    "- ran `bun run test` (exit 0)",
    "Agent: Done: tests pass.",
  ]);
});

it("names every command of a turn that ran only a few", () => {
  expect(renderTurn(2, [ran("ls"), ran("cat README.md")]).split("\n")).toEqual([
    "Turn 2",
    "- ran `ls` (exit 0)",
    "- ran `cat README.md` (exit 0)",
  ]);
});
