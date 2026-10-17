import { describe, expect, it, vi } from "vitest";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import type { SectionSource } from "../sources/contract.js";
import { readChips } from "./use-chips.js";

// The module source this imports talks to main only when a module runs.
vi.mock("./desktop-api.js", () => ({ desktopApi: {} }));

/** A source whose branches hold these rows, recording what was read. */
function fakeSource(branches: Record<string, SidebarSourceItem[]>) {
  const reads: (string | null)[] = [];
  const source: SectionSource = {
    title: "Chips",
    empty: "",
    capabilities: () => ({ move: false, drop: false, reveal: false }),
    load: async ({ parentId }) => {
      reads.push(parentId);
      return { items: branches[parentId ?? ""] ?? [] };
    },
  };
  return { source, reads };
}

const chip = (id: string, over: Partial<SidebarSourceItem> = {}) => ({
  id,
  label: id,
  ...over,
});

describe("readChips", () => {
  it("reads every chip as a flat tree, members by their group", async () => {
    const { source, reads } = fakeSource({
      "": [
        chip("pr"),
        // A group whose members the page already holds is not read again.
        chip("tabs", { hasChildren: true }),
        chip("tab-a", { parentId: "tabs" }),
        chip("agents", { hasChildren: true }),
      ],
      agents: [chip("agent-1", { hasChildren: true }), chip("agent-2")],
      "agent-1": [chip("step-1")],
      "step-1": [chip("too-deep")],
    });
    const chips = await readChips({
      source,
      session: { id: "s", title: null, metadata: {} },
      signal: new AbortController().signal,
    });
    expect(chips.map(({ id, parentId }) => [id, parentId])).toEqual([
      ["pr", null],
      ["tabs", null],
      ["tab-a", "tabs"],
      ["agents", null],
      ["agent-1", "agents"],
      ["agent-2", "agents"],
      ["step-1", "agent-1"],
    ]);
    expect(reads).toEqual([null, "agents", "agent-1"]);
  });
});
