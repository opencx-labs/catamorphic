import { describe, expect, it } from "vitest";
import { codexToolFilter } from "../codex-agent.js";

describe("codexToolFilter (Codex has no approval channel)", () => {
  it("allowlists when unknown tools must not run (auto/ask/deny defaults)", () => {
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
      opaque: {},
    };
    // Default auto: unknown → ask → fails closed → allowlist of allows.
    expect(codexToolFilter(layers, annotations)).toEqual({
      enabled_tools: ["list_channels", "post_message"],
    });
    expect(codexToolFilter(undefined, annotations)).toEqual({});
  });

  it("denylists when unknown tools may run (explicit allow default)", () => {
    expect(
      codexToolFilter([{ default: "allow", tools: { x: "deny", y: "ask" } }], {
        z: { readOnlyHint: true },
      }),
    ).toEqual({ disabled_tools: ["x", "y"] });
    expect(codexToolFilter([{ default: "allow" }], {})).toEqual({});
  });
});
