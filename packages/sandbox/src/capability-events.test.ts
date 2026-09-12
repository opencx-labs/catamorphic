import { expect, it } from "vitest";
import { capabilityEventPresenter } from "./capability-events.js";

it("preserves operation arguments across streamed tool updates and MCP App keys", () => {
  const present = capabilityEventPresenter();
  expect(
    present({
      type: "tool_call",
      toolUseId: "a",
      toolName: "mcp__host__invoke_capability",
      toolInput: {
        name: "workspace.open_browser",
        input: { url: "https://example.test" },
      },
    }),
  ).toMatchObject({
    toolName: "open_browser",
    toolInput: { url: "https://example.test" },
  });
  expect(
    present({
      type: "tool_call",
      toolUseId: "a",
      toolResult: { key: "browser:1" },
    }),
  ).toMatchObject({
    toolName: "open_browser",
    toolInput: { url: "https://example.test" },
    toolResult: { key: "browser:1" },
  });
  expect(
    present({
      type: "tool_call",
      toolName: "invoke_capability",
      toolInput: {
        name: "connections.maps.search%2Fplaces",
        input: { q: "Paris" },
      },
    }),
  ).toMatchObject({
    toolName: "maps/search/places",
    toolInput: { q: "Paris" },
  });
  expect(() =>
    present({
      type: "tool_call",
      toolName: "invoke_capability",
      toolInput: { name: "connections.maps.bad%name" },
    }),
  ).not.toThrow();
});
