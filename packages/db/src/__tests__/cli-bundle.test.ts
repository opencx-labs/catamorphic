import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "../..");
let directory: string;

beforeAll(async () => {
  // Inside the package, so the bundle's external imports resolve.
  const cache = path.join(packageRoot, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, "cli-bundle-"));
  // One file, every command's module inlined, as `catamorphic-db` ships.
  await run(
    "bun",
    [
      "build",
      path.join(packageRoot, "src/cli.ts"),
      "--outdir",
      directory,
      "--target",
      "node",
      "--format",
      "esm",
      "--packages",
      "external",
    ],
    { cwd: packageRoot },
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

// Each command module once ran itself when its file was the process entry;
// bundled into the CLI, `migrate` and `reset` both ran before any command,
// and `reset` empties the schema.
it("runs only the command it is given, and touches no database without one", async () => {
  const outcome = await run(
    process.execPath,
    [path.join(directory, "cli.js"), "no-such-command"],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        // Unroutable: a command that connects fails loudly instead.
        DATABASE_URL: "postgresql://nobody@127.0.0.1:9/nothing",
      },
    },
  ).then(
    () => ({ code: 0, stderr: "", stdout: "" }),
    (error: { code: number; stderr: string; stdout: string }) => error,
  );
  expect(outcome.code).toBe(1);
  expect(outcome.stderr).toContain(
    "Usage: catamorphic-db <migrate|status|reset>",
  );
  expect(`${outcome.stdout}${outcome.stderr}`).not.toMatch(
    /ECONNREFUSED|migrations applied|schema/i,
  );
});
