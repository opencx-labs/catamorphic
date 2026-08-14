import { describe, expect, it, vi } from "vitest";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  DURABLE_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
} from "../seeds.js";
import {
  activityLabel,
  buildAgentSystemPrompt,
  ensureBatchWorkflowSkill,
  ensureDurableWorkflowSkill,
  parsePorcelain,
} from "../services/agent-sessions-service.js";

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
  // The seed skills are the only scaffolding a project gets (ADR 0051), so
  // the authoring-model guarantees live on SEED_SKILLS.
  it("teaches the defineWorkflow authoring model", () => {
    const skill = SEED_SKILLS[".agents/skills/writing-workflows/SKILL.md"];
    const batchSkill = SEED_SKILLS[BATCH_WORKFLOW_SKILL_PATH];
    const durableSkill = SEED_SKILLS[DURABLE_WORKFLOW_SKILL_PATH];
    expect(skill).toBeDefined();
    expect(batchSkill).toBeDefined();
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
  });

  it("splits app mechanics from app doctrine (ADR 0049)", () => {
    const mechanics = SEED_SKILLS[".agents/skills/building-apps/SKILL.md"];
    const doctrine = SEED_SKILLS[".agents/skills/designing-apps/SKILL.md"];
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

/**
 * The ensure* probes run two `test -f` checks: the workflows workspace
 * gate (ADR 0043) and then the skill file itself. This fake answers each
 * by path, so tests state the project's shape declaratively.
 */
const fakeSandbox = ({
  workspace,
  skill,
}: {
  workspace: boolean;
  skill: boolean;
}) => ({
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

  it("restores from the host-resolved seed set, not the defaults (ADR 0049)", async () => {
    const sandboxProvider = fakeSandbox({ workspace: true, skill: false });

    const staged = await ensureBatchWorkflowSkill({
      sandboxProvider,
      sandboxProviderId: "sandbox-1",
      projectDir: "/workspace/project",
      seedFiles: { [BATCH_WORKFLOW_SKILL_PATH]: "# Acme batch conventions" },
    });

    expect(staged).toBe(true);
    expect(sandboxProvider.uploadFiles).toHaveBeenCalledWith(
      "sandbox-1",
      { [BATCH_WORKFLOW_SKILL_PATH]: "# Acme batch conventions" },
      "/workspace/project",
    );
  });

  it("never resurrects a skill the host removed from its seeds (ADR 0049)", async () => {
    const sandboxProvider = fakeSandbox({ workspace: true, skill: false });

    const staged = await ensureBatchWorkflowSkill({
      sandboxProvider,
      sandboxProviderId: "sandbox-1",
      projectDir: "/workspace/project",
      seedFiles: {},
    });

    expect(staged).toBe(false);
    expect(sandboxProvider.executeCommand).not.toHaveBeenCalled();
    expect(sandboxProvider.uploadFiles).not.toHaveBeenCalled();
  });
});
