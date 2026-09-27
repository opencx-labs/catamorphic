import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  HOST_SKILLS,
  renderTriggerTypesModule,
  SEED_SKILLS,
  TRIGGER_TYPES_SOURCE_PATH,
} from "@catamorphic/core";
import { parseProject } from "@catamorphic/parser";
import { expect, it } from "vitest";
import { schedule } from "../schedule-trigger-kind.js";
import { SESSION_TRIGGER_KINDS } from "../session-trigger-kinds.js";
import { webhook } from "../webhook-trigger-kind.js";

it("shipped workflow recipes typecheck against the public API and real host trigger schemas", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-types-"));
  const root = path.resolve(import.meta.dirname, "../../../..");
  const sources = path.join(directory, path.dirname(TRIGGER_TYPES_SOURCE_PATH));
  try {
    const skills = [
      ...["writing-workflows", "durable-workflows", "batch-workflows"].map(
        (name) => SEED_SKILLS[`.work/skills/${name}/SKILL.md`],
      ),
      HOST_SKILLS["session-workflows/SKILL.md"],
      HOST_SKILLS["slack/SKILL.md"],
      HOST_SKILLS["reviewing-pull-requests/SKILL.md"],
    ];
    // Recipes lay out like a project: a trigger library names its file on
    // its first line (`// .work/triggers/github.ts`); the rest are
    // workflow sources beside the generated trigger types.
    const files: Record<string, string> = {};
    let index = 0;
    for (const skill of skills) {
      if (!skill) throw new Error("Missing workflow skill");
      for (const match of skill.matchAll(/```typescript\n([\s\S]*?)```/g)) {
        const source = match[1] ?? "";
        const named = /^\/\/ (\.work\/\S+\.ts)\n/.exec(source)?.[1];
        files[named ?? `.work/workflows/src/recipe-${index}.ts`] = source;
        index += 1;
      }
    }
    // The review skill repeats the GitHub library verbatim (one file).
    expect(index).toBe(13);
    const parsed = parseProject(files);
    expect(parsed.errors).toEqual([]);
    expect(parsed.triggerKinds.map((kind) => kind.name)).toEqual([
      "github.delivery",
      "github.issue_comment",
      "github.pull_request",
      "github.pull_request_review_comment",
      "slack.event",
      "slack.mention",
      "slack.message",
    ]);
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(directory, file), content);
    }
    await fs.writeFile(
      path.join(directory, TRIGGER_TYPES_SOURCE_PATH),
      renderTriggerTypesModule({
        kinds: [schedule, webhook, ...SESSION_TRIGGER_KINDS],
        projectKinds: parsed.triggerKinds,
      }),
    );
    await fs.writeFile(
      path.join(sources, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [path.join(root, "node_modules/@types")],
          paths: {
            "@catamorphic/workflow": [
              path.join(root, "packages/workflow/src/index.ts"),
            ],
          },
        },
        include: ["*.ts"],
      }),
    );
    const result = await promisify(execFile)(
      path.join(root, "node_modules/.bin/tsgo"),
      ["--project", path.join(sources, "tsconfig.json")],
      { timeout: 30000 },
    );
    expect(result.stdout).toBe("");
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      throw new Error(`${error.message}\n${String(error.stdout)}`);
    }
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
