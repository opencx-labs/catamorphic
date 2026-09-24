import { describe, expect, it } from "vitest";
import { SEED_SKILLS } from "../seeds.js";
import {
  activityLabel,
  buildAgentSystemPrompt,
  checkpointMessage,
  liveStatusLine,
  modelVisibleDelivery,
  parsePorcelain,
} from "../services/agent-sessions-service.js";

describe("modelVisibleDelivery", () => {
  it("preserves human text and labels non-user input for the model", () => {
    expect(
      modelVisibleDelivery("Please continue", {
        kind: "user",
        externalUserId: "alice",
      }),
    ).toBe("Please continue");
    expect(
      modelVisibleDelivery("Checks failed", {
        kind: "watcher",
        watcherId: "watcher-1",
        runId: "run-1",
      }),
    ).toBe(
      "[Catamorphic watcher message from watcher-1, run run-1. This message was not written by the user.]\n\nChecks failed",
    );
  });
});

describe("liveStatusLine", () => {
  it("turns an agent's own words into one calm line", () => {
    expect(liveStatusLine("**Reviewing database migrations**")).toBe(
      "Reviewing database migrations",
    );
    expect(liveStatusLine("Run the test suite.\nThen fix it")).toBe(
      "Run the test suite. Then fix it",
    );
    expect(liveStatusLine("   ")).toBeUndefined();
    expect(liveStatusLine(undefined)).toBeUndefined();
    expect(liveStatusLine("x".repeat(200))?.length).toBe(80);
  });
});

describe("activityLabel", () => {
  it("keeps the live line calm: no paths, no raw commands, no tool names", () => {
    expect(activityLabel({ type: "done" })).toBe("Thinking...");
    // File names never surface on the live line — the event log has them.
    expect(
      activityLabel({ type: "file_edit", filePath: "src/workflow.ts" }),
    ).toBe("Editing files...");
    expect(activityLabel({ type: "tool_call", toolName: "read" })).toBe(
      "Working...",
    );
    // Preamble text never rides the live line — it lands as the message
    // itself when the segment flushes; showing it here would duplicate it.
    expect(
      activityLabel({
        type: "text",
        content: "I'll start by reviewing the schema.",
      }),
    ).toBe("Writing...");
  });

  it("pretty-prints well-known commands and hides the rest", () => {
    expect(activityLabel({ type: "command", content: "sleep 5" })).toBe(
      "Waiting...",
    );
    expect(
      activityLabel({ type: "command", content: "find . -name '*.ts'" }),
    ).toBe("Searching files...");
    expect(activityLabel({ type: "command", content: "bun test" })).toBe(
      "Running scripts...",
    );
    // Wrappers and env assignments don't hide the real program.
    expect(
      activityLabel({ type: "command", content: "FOO=1 env git status" }),
    ).toBe("Working with git...");
    // Compound commands classify by what runs first.
    expect(
      activityLabel({ type: "command", content: "ls -la && ./deploy.sh" }),
    ).toBe("Looking around...");
    // Unknown programs stay generic instead of leaking the command line.
    expect(
      activityLabel({
        type: "command",
        content: "./scripts/migrate.sh --force",
      }),
    ).toBe("Working...");
    expect(activityLabel({ type: "command" })).toBe("Working...");
  });
});

describe("parsePorcelain", () => {
  it("parses modified, added, untracked, and deleted entries", () => {
    const output = [
      " M src/index.ts",
      "A  src/new.ts",
      "?? notes.txt",
      " D removed.ts",
    ].join("\n");

    expect(parsePorcelain(output)).toEqual([
      { path: "src/index.ts", kind: "modified" },
      { path: "src/new.ts", kind: "modified" },
      { path: "notes.txt", kind: "modified" },
      { path: "removed.ts", kind: "deleted" },
    ]);
  });

  it("expands renames into delete + modify", () => {
    expect(parsePorcelain("R  old.ts -> new.ts")).toEqual([
      { path: "old.ts", kind: "deleted" },
      { path: "new.ts", kind: "modified" },
    ]);
  });

  it("unquotes paths with special characters", () => {
    expect(parsePorcelain('?? "file with space.txt"')).toEqual([
      { path: "file with space.txt", kind: "modified" },
    ]);
  });

  it("skips untracked directory entries", () => {
    expect(parsePorcelain("?? src/\n?? src/flow.ts")).toEqual([
      { path: "src/flow.ts", kind: "modified" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
    expect(parsePorcelain("\n\n")).toEqual([]);
  });
});

describe("seed skill set", () => {
  // Workflow authoring is exercised in workflow-skill-recipes.test.ts.
  it("splits app mechanics from app doctrine (ADR 0049)", () => {
    const mechanics = SEED_SKILLS[".catamorphic/skills/building-apps/SKILL.md"];
    const doctrine = SEED_SKILLS[".catamorphic/skills/designing-apps/SKILL.md"];
    expect(mechanics).toBeDefined();
    expect(doctrine).toBeDefined();

    // Mechanics: framework contracts every embedder needs.
    expect(mechanics).toContain("app-api.ts");
    expect(mechanics).toContain("preventDefault");
    expect(mechanics).toContain("process.env.NODE_ENV");
    expect(mechanics).toContain("a human publishes");
    expect(mechanics).toContain("localStorage");
    // No kit/design content in mechanics; the pointer is by ROLE, not name
    // duplication of doctrine.
    expect(mechanics).not.toContain("Component inventory");
    expect(mechanics).not.toContain("Motion doctrine");
    expect(mechanics).toContain("designing-apps skill");

    // Doctrine: the replaceable default for look and feel.
    expect(doctrine).toContain("name: designing-apps");
    expect(doctrine).toContain("@catamorphic/app/ui");
    expect(doctrine).toContain("useAsync");
    expect(doctrine).toContain("--color-");
    expect(doctrine).toContain("Motion doctrine");
    // Doctrine carries no framework contracts an embedder would lose by
    // replacing it.
    expect(doctrine).not.toContain("preventDefault");
    expect(doctrine).not.toContain("app-api.ts");
  });
});

describe("buildAgentSystemPrompt", () => {
  it("frames general work and defers mechanics to skills", () => {
    const prompt = buildAgentSystemPrompt({
      systemPrompt: "Use the host's billing plugin.",
    });

    expect(prompt).toContain("any kind of work");
    expect(prompt).toContain("Most requests are not about code");
    expect(prompt).toContain("what the person is looking at");
    expect(prompt).toContain("non-technical people");
    expect(prompt).toContain("load the matching skill");
    // Workflow mechanics arrive with the skill, not in every conversation.
    expect(prompt).not.toContain("defineBoundary");
    expect(prompt).not.toContain("Postgres");
    expect(prompt).toContain("Use the host's billing plugin.");
    expect(prompt.length).toBeLessThan(2400);
  });

  it("lets a host replace the standing prompt (ADR 0049)", () => {
    const prompt = buildAgentSystemPrompt({
      standingPrompt: "You are Acme's project agent.",
      systemPrompt: "Use the host's billing plugin.",
    });
    expect(prompt).toBe(
      "You are Acme's project agent.\n\nUse the host's billing plugin.",
    );
    expect(prompt).not.toContain("defineWorkflow");
  });

  it("lets a host remove the standing prompt with false (ADR 0049)", () => {
    expect(
      buildAgentSystemPrompt({
        standingPrompt: false,
        systemPrompt: "Use the host's billing plugin.",
      }),
    ).toBe("Use the host's billing plugin.");
    expect(buildAgentSystemPrompt({ standingPrompt: false })).toBe("");
  });
});

describe("checkpointMessage", () => {
  it("names a turn by its request, never the host's provenance header", () => {
    expect(checkpointMessage("Fix the login page\nIt 500s")).toBe(
      "Agent: Fix the login page",
    );
    expect(
      checkpointMessage(
        "[Catamorphic system message: background_command. This message was not written by the user.]\n\nWatch watch-1 (Deploy is live) succeeded on check 3.",
      ),
    ).toBe("Agent: Watch watch-1 (Deploy is live) succeeded on check 3.");
    expect(checkpointMessage("")).toBe("Agent checkpoint");
  });
});
