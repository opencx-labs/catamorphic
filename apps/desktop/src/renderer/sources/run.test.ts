import { describe, expect, it, vi } from "vitest";
import type { SectionSource } from "./contract.js";
import { runRowAction } from "./run.js";

const signal = new AbortController().signal;
function fixture() {
  const action = vi.fn<NonNullable<SectionSource["action"]>>(async () => ({
    open: "file:result.md",
  }));
  const source: SectionSource = {
    title: "Todos",
    empty: "Nothing due.",
    load: async () => ({ items: [] }),
    capabilities: () => ({ move: false, drop: false, reveal: false }),
    action,
  };
  return { source, action, open: vi.fn() };
}
describe("source open action normalization", () => {
  it.each([
    ["open", "replace"],
    ["open-here", "replace"],
    ["open-tab", "tab"],
    ["open-side", "side"],
    ["open-floating", "floating"],
  ] as const)(
    "normalizes %s and retains its effect's opening mode",
    async (verb, mode) => {
      const { source, action, open } = fixture();
      await runRowAction({
        source,
        itemId: "todo",
        action: verb,
        signal,
        open,
      });
      expect(action).toHaveBeenCalledWith({
        itemId: "todo",
        action: "open",
        mode,
        signal,
      });
      expect(open).toHaveBeenCalledWith("file:result.md", mode);
    },
  );
  it("passes context and modifiers together to an addressless row", async () => {
    const { source, action, open } = fixture();
    const session = { id: "s", title: "Plan", metadata: {} };
    const surface = { kind: "editor", path: "notes.md", sessionId: "s" };
    await runRowAction({
      source,
      itemId: "todo",
      action: "open",
      mode: "side",
      session,
      surface,
      signal,
      open,
    });
    expect(action).toHaveBeenCalledWith({
      itemId: "todo",
      action: "open",
      mode: "side",
      session,
      surface,
      signal,
    });
  });
  it("opens addressed rows without dispatching a source action", async () => {
    const { source, action, open } = fixture();
    await runRowAction({
      source,
      row: { id: "todo", label: "Todo", url: "file:todo.md" },
      itemId: "todo",
      action: "open",
      mode: "tab",
      signal,
      open,
    });
    expect(action).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("file:todo.md", "tab");
  });
});
