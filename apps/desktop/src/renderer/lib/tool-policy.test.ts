import { resolveToolPermissionAcross as sandboxResolve } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { agentLayer, resolveAcross } from "./tool-policy.js";

/** The renderer mirror must agree with the harness resolver, always. */
describe("renderer tool-policy mirror", () => {
  const cases = [
    { layers: [], tool: "x", ann: undefined },
    { layers: [], tool: "x", ann: { readOnlyHint: true } },
    {
      layers: [{ default: "deny" as const }],
      tool: "x",
      ann: { readOnlyHint: true },
    },
    {
      layers: [
        { tools: { x: "allow" as const } },
        agentLayer({ tools: { x: "ask" as const } }),
      ],
      tool: "x",
      ann: undefined,
    },
    {
      layers: [
        { default: "ask" as const },
        agentLayer({ tools: { y: "deny" as const } }),
      ],
      tool: "x",
      ann: { readOnlyHint: true },
    },
    {
      layers: [
        { default: "allow" as const, tools: { x: "deny" as const } },
        {},
        agentLayer(undefined),
      ],
      tool: "x",
      ann: undefined,
    },
    {
      layers: [
        { tools: { x: "ask" as const } },
        { default: "auto" as const },
        agentLayer({ default: "deny" as const }),
      ],
      tool: "z",
      ann: { readOnlyHint: true },
    },
  ];
  it.each(cases)("agrees for %j", ({ layers, tool, ann }) => {
    expect(resolveAcross(layers, tool, ann)).toBe(
      sandboxResolve(layers, tool, ann),
    );
  });
});
