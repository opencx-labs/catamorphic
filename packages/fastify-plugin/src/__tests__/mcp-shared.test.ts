import { describe, expect, it } from "vitest";
import { forwardedTool, forwardedToolResult } from "../mcp-shared.js";

describe("forwarding another MCP server's tools (ADR 0225)", () => {
  it("lists a tool as declared, leaving out an output schema these revisions forbid", () => {
    expect(
      forwardedTool({
        name: "rows",
        title: "Rows",
        description: "All rows",
        inputSchema: { type: "object" },
        outputSchema: { type: "array" },
        annotations: { readOnlyHint: true },
      }),
    ).toEqual({
      name: "rows",
      title: "Rows",
      description: "All rows",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
  });

  it("keeps a result as the server sent it", () => {
    const result = {
      content: [{ type: "text", text: "no such row" }],
      structuredContent: { row: null },
      isError: true,
      _meta: { trace: "t-1" },
    };
    expect(forwardedToolResult(result)).toEqual(result);
  });

  it("leaves out structured content that is not an object, keeping the text", () => {
    expect(
      forwardedToolResult({
        content: [{ type: "text", text: "[1,2]" }],
        structuredContent: [1, 2],
      }),
    ).toEqual({ content: [{ type: "text", text: "[1,2]" }] });
    expect(
      forwardedToolResult({ content: [], structuredContent: [1, 2] }),
    ).toEqual({ content: [{ type: "text", text: "[1,2]" }] });
  });

  it("answers anything else as a value, since the call has already run", () => {
    expect(forwardedToolResult({ rows: 2 })).toEqual({
      content: [{ type: "text", text: '{"rows":2}' }],
      structuredContent: { rows: 2 },
    });
  });
});
