import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { pruneCiCache } from "./ci-cache-prune.js";
import { toolRuntime } from "./tool-runtime.js";

const repository = path.resolve(import.meta.dirname, "..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Task {
  taskId: string;
  hash: string;
  task: string;
}

/** Exercise the installed Turbo engine with this repository's task definitions. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ct-cache-"));
  directories.push(root);
  const write = (file: string, contents: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };
  const config = JSON.parse(
    readFileSync(path.join(repository, "turbo.json"), "utf8"),
  );
  config.tasks = Object.fromEntries(
    Object.entries(config.tasks).filter(([name]) =>
      [
        "test",
        "build",
        "catamorphic-desktop#build",
        "catamorphic-desktop#test:e2e:ci",
        "catamorphic-pwa#test:e2e:ci",
      ].includes(name),
    ),
  );
  write("turbo.json", JSON.stringify(config));
  write(
    "package.json",
    JSON.stringify({
      name: "cache-fixture",
      private: true,
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*"],
    }),
  );
  write(
    ".gitignore",
    "node_modules/\n.turbo/\n*.log\n.failed-once\ndist/\nout/\n",
  );
  write("scripts/shared.ts", "// shared fixture\n");
  // The recorder runs at the package cwd; keep its event log there so ignored
  // runtime output cannot accidentally invalidate a cached success.
  write(
    "record.cjs",
    `const fs = require('node:fs');
const name = JSON.parse(fs.readFileSync('package.json', 'utf8')).name;
fs.appendFileSync('events.log', name + '\\n');
if (fs.existsSync('fail') && !fs.existsSync('.failed-once')) {
  fs.writeFileSync('.failed-once', 'failed');
  process.exit(1);
}
`,
  );
  for (const [name, dependencies] of Object.entries({
    upstream: [],
    consumer: ["upstream"],
    unrelated: [],
    "catamorphic-server": ["upstream"],
    "catamorphic-pwa": [],
    "catamorphic-desktop": ["consumer"],
  })) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({
        name,
        scripts: {
          build: "node -e \"console.log('build')\"",
          test: "node ../../record.cjs",
          ...(["catamorphic-pwa", "catamorphic-desktop"].includes(name)
            ? { "test:e2e:ci": "node ../../record.cjs" }
            : {}),
        },
        dependencies: Object.fromEntries(
          dependencies.map((dependency) => [dependency, "workspace:*"]),
        ),
      }),
    );
    write(`packages/${name}/source.ts`, "// initial\n");
  }
  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: root,
    stdio: "pipe",
  });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const runtime = toolRuntime({ rootPath: repository, env: process.env });
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      runtime.nodePath,
      [
        path.join(repository, "node_modules/turbo/bin/turbo"),
        "run",
        "test",
        "test:e2e:ci",
        "--no-daemon",
        "--concurrency=2",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...runtime.env,
          TURBO_CACHE_DIR: path.join(root, ".turbo/cache"),
          CATAMORPHIC_TEST_RUNTIME: "fixture-linux",
          CATAMORPHIC_TEST_SHARD: "1/2",
          ...env,
        },
      },
    );
  const hashes = (env?: NodeJS.ProcessEnv): Task[] => {
    const result = run(["--dry=json"], env);
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout).tasks;
  };
  const events = (name: string) =>
    readFileSync(path.join(root, `packages/${name}/events.log`), "utf8")
      .trim()
      .split("\n").length;
  return { root, write, run, hashes, events };
}

function changed(before: Task[], after: Task[]): string[] {
  return after
    .filter(
      (task) =>
        before.find((previous) => previous.taskId === task.taskId)?.hash !==
        task.hash,
    )
    .map((task) => task.taskId)
    .sort();
}

it("selects only changed packages and consumers, including implicit E2E consumers", () => {
  const f = fixture();
  const before = f.hashes();
  f.write("packages/upstream/source.ts", "// changed upstream\n");
  const upstream = f.hashes();
  expect(
    changed(before, upstream).filter((id) => id.endsWith("#test")),
  ).toEqual([
    "catamorphic-desktop#test",
    "catamorphic-server#test",
    "consumer#test",
    "upstream#test",
  ]);
  expect(changed(before, upstream)).toContain("catamorphic-pwa#test:e2e:ci");
  expect(changed(before, upstream)).not.toContain("unrelated#build");
  f.write("packages/catamorphic-pwa/source.ts", "// changed mobile guest\n");
  expect(changed(upstream, f.hashes())).toContain(
    "catamorphic-desktop#test:e2e:ci",
  );
});

it("hashes shared infrastructure and platform, but keeps random database ports and shards out of build hashes", () => {
  const f = fixture();
  const before = f.hashes();
  expect(
    changed(
      before,
      f.hashes({ DATABASE_URL: "postgresql://localhost:49222/test" }),
    ),
  ).toEqual([]);
  const shardChanges = changed(
    before,
    f.hashes({ CATAMORPHIC_TEST_SHARD: "2/2" }),
  );
  expect(shardChanges.length).toBeGreaterThan(0);
  expect(shardChanges.every((id) => !id.endsWith("#build"))).toBe(true);
  expect(
    changed(before, f.hashes({ CATAMORPHIC_TEST_RUNTIME: "fixture-macos" }))
      .length,
  ).toBe(before.length);
  f.write("scripts/shared.ts", "// new fixture behavior\n");
  expect(changed(before, f.hashes()).length).toBe(before.length);
});

it("reuses real successful tasks across pushes while retrying unchanged failures", () => {
  const f = fixture();
  const initial = f.run([]);
  expect(initial.status, initial.stdout + initial.stderr).toBe(0);
  expect(f.events("unrelated")).toBe(1);
  expect(f.run([]).status).toBe(0);
  expect(f.events("unrelated")).toBe(1);
  f.write("packages/upstream/source.ts", "// next push\n");
  expect(f.run([]).status).toBe(0);
  expect(f.events("consumer")).toBe(2);
  expect(f.events("unrelated")).toBe(1);
  f.write("packages/unrelated/fail", "fail once");
  expect(f.run([]).status).not.toBe(0);
  expect(f.events("unrelated")).toBe(2);
  expect(f.run([]).status).toBe(0);
  expect(f.events("unrelated")).toBe(3);
  expect(f.events("consumer")).toBe(2);
  expect(f.run(["--force"]).status).toBe(0);
  expect(f.events("consumer")).toBe(3);
}, 60_000);

it("bounds cache archives to the current job graph without losing reusable successes", () => {
  const f = fixture();
  expect(f.run(["--summarize"]).status).toBe(0);
  rmSync(path.join(f.root, ".turbo/runs"), { recursive: true, force: true });
  f.write("packages/upstream/source.ts", "// later revision\n");
  expect(f.run(["--summarize"]).status).toBe(0);
  expect(pruneCiCache(f.root)).toBeGreaterThan(0);
  expect(f.run([]).status).toBe(0);
  expect(f.events("consumer")).toBe(2);
  expect(f.events("unrelated")).toBe(1);
  rmSync(path.join(f.root, ".turbo/runs"), { recursive: true, force: true });
  expect(pruneCiCache(f.root)).toBe(0);
}, 30_000);
