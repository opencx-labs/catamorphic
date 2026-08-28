import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { checkCommands } from "./check-plan.js";
import { writeCliError } from "./cli-error.js";
import {
  createTestRunResources,
  runLoggedProcess,
  TestSignalController,
  testRunEnvironment,
} from "./test.js";
import {
  deterministicTestEnvironment,
  dockerTestPostgresDriver,
  withDisposablePostgres,
} from "./test-postgres.js";
import { toolRuntime } from "./tool-runtime.js";

function logFileName(input: { index: number; label: string }): string {
  const label = input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${String(input.index + 1).padStart(2, "0")}-${label}.log`;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const nonce = randomUUID();
  const resources = await createTestRunResources({ pid: process.pid, nonce });
  const signals = new TestSignalController();
  const runtime = toolRuntime({ rootPath: repositoryRoot, env: process.env });
  let succeeded = false;
  let exitCode = 1;
  try {
    await withDisposablePostgres({
      driver: dockerTestPostgresDriver(),
      pid: process.pid,
      nonce,
      task: async (databaseUrl) => {
        const env = testRunEnvironment({
          source: deterministicTestEnvironment(runtime.env, databaseUrl),
          resources,
        });
        for (const [index, phase] of checkCommands().entries()) {
          console.log(
            `\n[check ${index + 1}/${checkCommands().length}] ${phase.label}`,
          );
          const result = await runLoggedProcess({
            command: phase.command,
            args: phase.args,
            cwd: repositoryRoot,
            env,
            logPath: path.join(
              resources.logsPath,
              logFileName({ index, label: phase.label }),
            ),
            signals,
          });
          exitCode = result.code;
          if (result.code !== 0) {
            throw new Error(
              `Check phase ${JSON.stringify(phase.label)} exited with code ${result.code}`,
            );
          }
        }
      },
    });
    succeeded = true;
    exitCode = 0;
  } catch (error) {
    writeCliError(error);
  } finally {
    signals.close();
    if (succeeded) {
      await rm(resources.rootPath, { recursive: true, force: true });
    } else {
      console.error(`Check diagnostics preserved at ${resources.rootPath}`);
    }
  }
  process.exitCode = exitCode;
}

if (import.meta.main) {
  await main();
}
