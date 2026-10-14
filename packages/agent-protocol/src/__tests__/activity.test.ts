import { describe, expect, it } from "vitest";
import { commandActivity, itemActivity } from "../activity.js";
import type { Item } from "../model.js";

describe("commandActivity", () => {
  it("names well-known programs and nothing else", () => {
    expect(commandActivity("sleep 5")).toBe("Waiting...");
    expect(commandActivity("find . -name '*.ts'")).toBe("Searching files...");
    expect(commandActivity("bun test")).toBe("Running scripts...");
    expect(commandActivity("FOO=1 env git status")).toBe("Working with git...");
    expect(commandActivity("/usr/bin/rg foo | head")).toBe(
      "Searching files...",
    );
    expect(commandActivity("./deploy.sh")).toBe("Working...");
    expect(commandActivity(undefined)).toBe("Working...");
  });
});

describe("itemActivity", () => {
  const step = (item: Partial<Item>) => ({ id: "i1", ...item }) as Item;
  it("says a step's own description as one line, else a verb", () => {
    expect(
      itemActivity(
        step({
          kind: "command",
          command: "rg -n vad src",
          description: " Read the VAD options\n and their history ",
        }),
      ),
    ).toBe("Read the VAD options and their history");
    expect(
      itemActivity(
        step({ kind: "command", command: "rg vad", description: null }),
      ),
    ).toBe("Searching files...");
    expect(
      itemActivity(
        step({
          kind: "tool_call",
          tool: "run_query",
          description: "Count calls by day",
        }),
      ),
    ).toBe("Count calls by day");
    expect(
      itemActivity(
        step({ kind: "tool_call", tool: "run_query", description: "  " }),
      ),
    ).toBe("Working...");
  });
});
