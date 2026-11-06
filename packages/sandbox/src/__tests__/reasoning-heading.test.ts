import { describe, expect, it } from "vitest";
import { reasoningHeading } from "../agent-capabilities.js";

describe("reasoningHeading", () => {
  it("is the latest bold title opening a line", () => {
    expect(
      reasoningHeading(
        "**Reading the parser**\n\nIt walks the AST.\n\n**Fixing the walk**\n\nThe visitor skips",
      ),
    ).toBe("Fixing the walk");
    expect(
      reasoningHeading("**Reading the parser**\n\n**Note:** the walk skips"),
    ).toBe("Reading the parser");
  });

  it("is nothing for a bold lead-in or word, an unclosed title or prose", () => {
    expect(reasoningHeading("**Plan:** read, then fix")).toBeUndefined();
    expect(
      reasoningHeading("I should check **app.tsx** first."),
    ).toBeUndefined();
    expect(reasoningHeading("**Reading the par")).toBeUndefined();
    expect(reasoningHeading("Found it: the caller said yes.")).toBeUndefined();
  });
});
