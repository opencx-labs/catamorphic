import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  HOST_SKILLS,
  renderTriggerTypesModule,
  SEED_SKILLS,
} from "@catamorphic/core";
import { expect, it } from "vitest";
import { schedule } from "../schedule-trigger-kind.js";
import { SESSION_TRIGGER_KINDS } from "../session-trigger-kinds.js";

it("shipped workflow recipes typecheck against the public API and real host trigger schemas", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-types-"));
  const root = path.resolve(import.meta.dirname, "../../../..");
  try {
    const skills = [
      ...["writing-workflows", "durable-workflows", "batch-workflows"].map(
        (name) => SEED_SKILLS[`.catamorphic/skills/${name}/SKILL.md`],
      ),
      HOST_SKILLS["session-workflows/SKILL.md"],
    ];
    let index = 0;
    for (const skill of skills) {
      if (!skill) throw new Error("Missing workflow skill");
      for (const match of skill.matchAll(/```typescript\n([\s\S]*?)```/g)) {
        await fs.writeFile(
          path.join(directory, `recipe-${index++}.ts`),
          match[1] ?? "",
        );
      }
    }
    expect(index).toBe(6);
    await fs.writeFile(
      path.join(directory, "catamorphic-triggers.d.ts"),
      renderTriggerTypesModule([schedule, ...SESSION_TRIGGER_KINDS]),
    );
    await fs.writeFile(
      path.join(directory, "tsconfig.json"),
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
      ["--project", path.join(directory, "tsconfig.json")],
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
