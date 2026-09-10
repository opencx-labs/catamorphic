import { describe, expect, it } from "vitest";
import { agentToolResult, extraToolResult } from "./tool-result.js";

describe("host tool media", () => {
  it("preserves text and images while ordinary domain results stay JSON", () => {
    const content = [
      { type: "text", text: "Viewport" },
      { type: "image", mimeType: "image/png", data: "AA==" },
    ] as const;
    expect(extraToolResult(agentToolResult({ content: [...content] }))).toEqual(
      { content },
    );
    expect(extraToolResult({ content })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ content }, null, 2) }],
    });
  });
  it("does not disguise invalid media as a successful result", () => {
    expect(() =>
      extraToolResult({
        kind: "agent-tool-result",
        content: [{ type: "image", mimeType: "text/html", data: "bad" }],
      }),
    ).toThrow();
    expect(
      extraToolResult(
        agentToolResult({
          isError: true,
          content: [{ type: "text", text: "Unavailable" }],
        }),
      ),
    ).toHaveProperty("isError", true);
  });
});
