import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const vitestConfigurations = [
  ["root", "vitest.config.ts"],
  ["app", "packages/app/vitest.config.ts"],
  ["react", "packages/react/vitest.config.ts"],
  ["ui", "packages/ui/vitest.config.ts"],
  ["PWA", "apps/pwa/vitest.config.ts"],
] as const;

describe("Vitest concurrency", () => {
  it.each(vitestConfigurations)(
    "bounds file workers for the %s configuration",
    async (_label, configurationPath) => {
      const tempDirectory = await mkdtemp(
        path.join(os.tmpdir(), "catamorphic-vitest-workers-"),
      );
      const observationsPath = path.join(tempDirectory, "workers");
      const preloadPath = path.join(tempDirectory, "available-parallelism.mjs");
      try {
        await Promise.all([
          mkdir(path.join(tempDirectory, "src", "__tests__"), {
            recursive: true,
          }),
          mkdir(path.join(tempDirectory, "src", "test"), { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            path.join(tempDirectory, "src", "__tests__", "setup.ts"),
            "",
          ),
          writeFile(path.join(tempDirectory, "src", "test", "setup.ts"), ""),
        ]);
        await writeFile(
          preloadPath,
          [
            'import os from "node:os";',
            'import { syncBuiltinESMExports } from "node:module";',
            "os.availableParallelism = () => 8;",
            "syncBuiltinESMExports();",
            "",
          ].join("\n"),
        );
        const vitestImport = JSON.stringify(
          new URL("../node_modules/vitest/dist/index.js", import.meta.url).href,
        );
        for (let index = 0; index < 4; index += 1) {
          await writeFile(
            path.join(tempDirectory, "src", `worker-${index}.test.ts`),
            [
              'import { appendFile } from "node:fs/promises";',
              `import { test } from ${vitestImport};`,
              `test("records worker ${index}", async () => {`,
              `  await appendFile(${JSON.stringify(observationsPath)}, (process.env.VITEST_POOL_ID ?? "missing") + "\\n");`,
              "});",
              "",
            ].join("\n"),
          );
        }

        await execFileAsync(
          path.join(repositoryRoot, "node_modules", "node", "bin", "node"),
          [
            "--import",
            preloadPath,
            path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
            "run",
            "--config",
            path.join(repositoryRoot, configurationPath),
            "--root",
            tempDirectory,
            "--environment",
            "node",
          ],
          { cwd: repositoryRoot },
        );

        const workerIds = (await readFile(observationsPath, "utf8"))
          .trim()
          .split("\n");
        expect(workerIds).toHaveLength(4);
        expect(workerIds).not.toContain("missing");
        expect(new Set(workerIds).size).toBeLessThanOrEqual(2);
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
  );
});
