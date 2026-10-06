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
import { checkProject, parseProject } from "@catamorphic/parser";
import { expect, it } from "vitest";
import { DIRECTORY_TRIGGER_KINDS } from "../directory-trigger-kinds.js";
import { schedule } from "../schedule-trigger-kind.js";
import { SESSION_TRIGGER_KINDS } from "../session-trigger-kinds.js";
import { webhook } from "../webhook-trigger-kind.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const HOST_KINDS = [
  schedule,
  webhook,
  ...SESSION_TRIGGER_KINDS,
  ...DIRECTORY_TRIGGER_KINDS,
];

/**
 * Lay recipes out like a project: a trigger library or workflow source that
 * names its file on its first line (`// .work/triggers/github.ts`) goes
 * there; the rest are workflow sources beside the generated trigger types.
 */
function recipeFiles(documents: readonly (string | undefined)[]): {
  files: Record<string, string>;
  count: number;
} {
  const files: Record<string, string> = {};
  let count = 0;
  for (const document of documents) {
    if (!document) throw new Error("Missing workflow skill");
    for (const match of document.matchAll(/```typescript\n([\s\S]*?)```/g)) {
      const source = match[1] ?? "";
      const named = /^\/\/ (\.work\/\S+\.ts)\n/.exec(source)?.[1];
      files[named ?? `.work/workflows/src/recipe-${count}.ts`] = source;
      count += 1;
    }
  }
  return { files, count };
}

/** Type-check recipes against the public API and real host trigger schemas. */
async function typecheck(files: Record<string, string>): Promise<void> {
  const parsed = parseProject(files);
  expect(parsed.errors).toEqual([]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-types-"));
  const sources = path.join(directory, path.dirname(TRIGGER_TYPES_SOURCE_PATH));
  try {
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(directory, file), content);
    }
    await fs.writeFile(
      path.join(directory, TRIGGER_TYPES_SOURCE_PATH),
      renderTriggerTypesModule({
        kinds: HOST_KINDS,
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
}

it("shipped workflow recipes typecheck against the public API and real host trigger schemas", async () => {
  const { files, count } = recipeFiles([
    ...["writing-workflows", "durable-workflows", "batch-workflows"].map(
      (name) => SEED_SKILLS[`.work/skills/${name}/SKILL.md`],
    ),
    HOST_SKILLS["session-workflows/SKILL.md"],
    HOST_SKILLS["slack/SKILL.md"],
    HOST_SKILLS["reviewing-pull-requests/SKILL.md"],
  ]);
  // The review skill repeats the GitHub library verbatim (one file).
  expect(count).toBe(14);
  expect(parseProject(files).triggerKinds.map((kind) => kind.name)).toEqual([
    "github.delivery",
    "github.issue_comment",
    "github.pull_request",
    "github.pull_request_review_comment",
    "slack.event",
    "slack.mention",
    "slack.message",
  ]);
  await typecheck(files);
});

it("the onboarding automation in the Work server setup guide typechecks and passes the host's check", async () => {
  const guide = await fs.readFile(
    path.join(root, "skills/setup-work-server/references/company-identity.md"),
    "utf8",
  );
  const { files, count } = recipeFiles([guide]);
  expect(Object.keys(files)).toEqual([
    ".work/workflows/src/clickhouse-keys.ts",
  ]);
  expect(count).toBe(1);
  // The deploy rules too: directory kinds need memberships:read.
  const check = checkProject(files, {
    triggerKinds: HOST_KINDS.map((kind) => ({
      name: kind.name,
      configJsonSchema: kind.configJsonSchema,
      payloadJsonSchema: kind.payloadJsonSchema,
      ...(kind.requiredPermissions
        ? { requiredPermissions: kind.requiredPermissions }
        : {}),
    })),
  });
  expect(check.findings).toEqual([]);
  await typecheck(files);
});
