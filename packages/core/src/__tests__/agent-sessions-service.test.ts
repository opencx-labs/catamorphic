import { describe, expect, it, vi } from "vitest";
import {
  activityLabel,
  buildAgentSystemPrompt,
  ensureBatchWorkflowSkill,
  ensureDurableWorkflowSkill,
  parsePorcelain,
} from "../services/agent-sessions-service.js";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  DURABLE_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
  TEMPLATES,
} from "../templates.js";

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

describe("template skill seeding", () => {
  it("every template teaches the defineWorkflow authoring model", () => {
    for (const template of TEMPLATES) {
      const skill = template.files[".agents/skills/writing-workflows/SKILL.md"];
      const batchSkill = template.files[BATCH_WORKFLOW_SKILL_PATH];
      const durableSkill = template.files[DURABLE_WORKFLOW_SKILL_PATH];
      expect(skill, `template ${template.id}`).toBeDefined();
      expect(batchSkill, `template ${template.id}`).toBeDefined();
      expect(skill).toContain("name: writing-workflows");
      expect(skill).toContain("defineWorkflow");
      expect(skill).toContain('"use step"');
      expect(skill).toContain("defineBatch");
      expect(skill).toContain("defineBoundary");
      // Plain "use workflow" functions are gone; the skill must not teach them.
      expect(skill).not.toContain('"use workflow"');
      expect(batchSkill).toContain("name: batch-workflows");
      expect(batchSkill).toContain("defineBatchStep");
      expect(batchSkill).toContain("acknowledgedKeys");
      expect(durableSkill).toContain("name: durable-workflows");
      expect(durableSkill).toContain("BoundaryContext");
      expect(durableSkill).toContain("__catamorphicWorkflowTypeError");
      expect(durableSkill).toContain("Return callWorkflow");
      expect(durableSkill).toContain("controls: { cancel: true }");
      expect(durableSkill).toContain("visualization");
    }
  });
});

describe("buildAgentSystemPrompt", () => {
  it("teaches the defineWorkflow model and preserves host instructions", () => {
    const prompt = buildAgentSystemPrompt({
      systemPrompt: "Use the host's billing plugin.",
    });

    expect(prompt).toContain("exported defineWorkflow");
    expect(prompt).toContain('There is no "use workflow" directive');
    expect(prompt).toContain('"use step"');
    expect(prompt).toContain("defineBatch");
    expect(prompt).toContain("defineBoundary");
    expect(prompt).toContain("execute ordered boundary and batch scopes");
    expect(prompt).toContain("continuation state persisted in Postgres");
    expect(prompt).toContain("controls: { cancel: true }");
    expect(prompt).toContain("@catamorphic/workflow");
    expect(prompt).toContain("Never create local copies");
    expect(prompt).toContain("Use the host's billing plugin.");
  });
});

/**
 * The ensure* probes run two `test -f` checks: the workflows workspace
 * gate (ADR 0043) and then the skill file itself. This fake answers each
 * by path, so tests state the project's shape declaratively.
 */
const fakeSandbox = ({ workspace, skill }: { workspace: boolean; skill: boolean }) => ({
  executeCommand: vi.fn(async (_id: string, command: string) => ({
    exitCode: command.includes("workflows/package.json")
      ? workspace
        ? 0
        : 1
      : skill
        ? 0
        : 1,
    result: "",
  })),
  uploadFiles: vi.fn().mockResolvedValue(undefined),
});

describe("ensureDurableWorkflowSkill", () => {
  it("stages the skill for a workflow project that does not have it", async () => {
    const sandboxProvider = fakeSandbox({ workspace: true, skill: false });

    const staged = await ensureDurableWorkflowSkill({
      sandboxProvider,
      sandboxProviderId: "sandbox-1",
      projectDir: "/workspace/project",
    });

    expect(staged).toBe(true);
    expect(sandboxProvider.uploadFiles).toHaveBeenCalledWith(
      "sandbox-1",
      {
        [DURABLE_WORKFLOW_SKILL_PATH]: SEED_SKILLS[DURABLE_WORKFLOW_SKILL_PATH],
      },
      "/workspace/project",
    );
  });

  it("never resurrects the skill in a project without a workflows workspace (ADR 0043)", async () => {
    const sandboxProvider = fakeSandbox({ workspace: false, skill: false });

    const staged = await ensureDurableWorkflowSkill({
      sandboxProvider,
      sandboxProviderId: "sandbox-1",
      projectDir: "/workspace/project",
    });

    expect(staged).toBe(false);
    expect(sandboxProvider.uploadFiles).not.toHaveBeenCalled();
  });
});

describe("ensureBatchWorkflowSkill", () => {
  it("stages the skill for a workflow project that does not have it", async () => {
    const sandboxProvider = fakeSandbox({ workspace: true, skill: false });

    const staged = await ensureBatchWorkflowSkill({
      sandboxProvider,
      sandboxProviderId: "sandbox-1",
      projectDir: "/workspace/project",
    });

    expect(staged).toBe(true);
    expect(sandboxProvider.uploadFiles).toHaveBeenCalledWith(
      "sandbox-1",
      {
        [BATCH_WORKFLOW_SKILL_PATH]: SEED_SKILLS[BATCH_WORKFLOW_SKILL_PATH],
      },
      "/workspace/project",
    );
  });

  it("preserves a project-provided batch skill", async () => {
    const sandboxProvider = {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: "" }),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
    };

    const staged = await ensureBatchWorkflowSkill({
      sandboxProvider,
      sandboxProviderId: "sandbox-1",
      projectDir: "/workspace/project",
    });

    expect(staged).toBe(false);
    expect(sandboxProvider.uploadFiles).not.toHaveBeenCalled();
  });
});
