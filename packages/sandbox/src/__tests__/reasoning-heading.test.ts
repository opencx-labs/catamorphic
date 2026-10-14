import { describe, expect, it } from "vitest";
import { reasoningHeading } from "../agent-capabilities.js";

describe("reasoningHeading", () => {
  it("is the latest bold title opening a line", () => {
    expect(
      reasoningHeading(
        "**Reading the parser**\n\nIt walks the AST.\n\n**Fixing the walk**\n\nThe visitor skips",
      ),
    ).toBe("Fixing the walk");
    expect(reasoningHeading("**Plan:** read, then fix")).toBe("Plan:");
  });

  it("is nothing for a bold word mid-sentence, an unclosed title or prose", () => {
    expect(
      reasoningHeading("I should check **app.tsx** first."),
    ).toBeUndefined();
    expect(reasoningHeading("**Reading the par")).toBeUndefined();
    expect(reasoningHeading("Found it: the caller said yes.")).toBeUndefined();
  });
});
