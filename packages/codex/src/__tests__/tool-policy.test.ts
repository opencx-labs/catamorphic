import { describe, expect, it } from "vitest";
import { disabledToolsFor } from "../codex-agent.js";

describe("disabledToolsFor (Codex has no approval channel)", () => {
  it("disables deny AND ask tools it can resolve; leaves allowed ones", () => {
    const layers = [
      {
        tools: {
          delete_channel: "deny" as const,
          post_message: "allow" as const,
        },
      },
    ];
    const annotations = {
      list_channels: { readOnlyHint: true },
      create_channel: { readOnlyHint: false },
    };
    expect(disabledToolsFor(layers, annotations)).toEqual([
      "create_channel", // auto → ask → fails closed
      "delete_channel",
    ]);
    expect(disabledToolsFor(undefined, annotations)).toEqual([]);
    // Explicit allow default: nothing to disable but the explicit deny.
    expect(
      disabledToolsFor(
        [{ default: "allow", tools: { x: "deny" } }],
        annotations,
      ),
    ).toEqual(["x"]);
  });
});
