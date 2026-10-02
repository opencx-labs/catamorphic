import { describe, expect, it } from "vitest";
import { commandActivity } from "../activity.js";

describe("commandActivity", () => {
  it("names well-known programs and nothing else", () => {
    expect(commandActivity("sleep 5")).toBe("Waiting...");
    expect(commandActivity("find . -name '*.ts'")).toBe("Searching files...");
    expect(commandActivity("bun test")).toBe("Running scripts...");
    expect(commandActivity("FOO=1 env git status")).toBe("Working with git...");
    expect(commandActivity("/usr/bin/rg foo | head")).toBe("Searching files...");
    expect(commandActivity("./deploy.sh")).toBe("Working...");
    expect(commandActivity(undefined)).toBe("Working...");
  });
});
