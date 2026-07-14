import { describe, expect, it, vi } from "vitest";
import {
  buildAgentSystemPrompt,
  ensureBatchWorkflowSkill,
  parsePorcelain,
} from "../services/agent-sessions-service.js";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
  TEMPLATES,
} from "../templates.js";

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
  it("every template teaches both workflow kinds", () => {
    for (const template of TEMPLATES) {
      const skill = template.files[".agents/skills/writing-workflows/SKILL.md"];
      const batchSkill = template.files[BATCH_WORKFLOW_SKILL_PATH];
      expect(skill, `template ${template.id}`).toBeDefined();
      expect(batchSkill, `template ${template.id}`).toBeDefined();
      expect(skill).toContain("name: writing-workflows");
      expect(skill).toContain('"use workflow"');
      expect(skill).toContain("defineBatchWorkflow");
      expect(skill).toContain("preserve its kind");
      expect(batchSkill).toContain("name: batch-workflows");
      expect(batchSkill).toContain("defineBatchStep");
      expect(batchSkill).toContain("acknowledgedKeys");
    }
  });
});

describe("buildAgentSystemPrompt", () => {
  it("always distinguishes workflow kinds and preserves host instructions", () => {
    const prompt = buildAgentSystemPrompt({
      systemPrompt: "Use the host's billing plugin.",
    });

    expect(prompt).toContain('"use workflow"');
    expect(prompt).toContain("defineBatchWorkflow");
    expect(prompt).toContain("preserve its workflow kind");
    expect(prompt).toContain("@catamorphic/workflow");
    expect(prompt).toContain("Never create a local src/batch.ts");
    expect(prompt).toContain("Use the host's billing plugin.");
  });
});

describe("ensureBatchWorkflowSkill", () => {
  it("stages the skill for an existing project that does not have it", async () => {
    const sandboxProvider = {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, result: "" }),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
    };

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
