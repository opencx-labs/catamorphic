import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_HARNESS_SOURCE } from "../harness.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("runtime harness", () => {
  it("reports call-site step ids and workflow output", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-runtime-"),
    );
    directories.push(directory);
    await fs.writeFile(
      path.join(directory, "workflow.ts"),
      `
async function double({ value }: { value: number }) {
  "use step";
  return value * 2;
}

export async function example({ value }: { value: number }) {
  "use workflow";
  return globalThis.__catamorphicRunStep(
    "node_2",
    "Double",
    (__catamorphicInput) => double(__catamorphicInput),
    { value },
  );
}
`,
    );
    await fs.writeFile(
      path.join(directory, "harness.ts"),
      RUNTIME_HARNESS_SOURCE,
    );

    const { stdout: output } = await execFileAsync(
      "bun",
      ["run", "harness.ts"],
      {
        cwd: directory,
        env: {
          ...process.env,
          CATAMORPHIC_RUN_ID: "00000000-0000-0000-0000-000000000001",
          CATAMORPHIC_WORKFLOW_NAME: "example",
          CATAMORPHIC_WORKFLOW_FILE: "workflow.ts",
          CATAMORPHIC_TRIGGER_DATA: '{"value":4}',
        },
      },
    );

    const marker = "CATAMORPHIC_REPORT:";
    const report = JSON.parse(
      output.slice(output.indexOf(marker) + marker.length).trim(),
    ) as {
      result: number;
      steps: Array<{ nodeId: string; output: number }>;
    };
    expect(report.result).toBe(8);
    expect(report.steps).toEqual([
      expect.objectContaining({ nodeId: "node_2", output: 8 }),
    ]);
  });
});
