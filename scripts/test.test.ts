import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRunResources,
  runLoggedProcess,
  TestSignalController,
  testRunCommands,
  testRunEnvironment,
  turboTestArguments,
} from "./test.js";
import {
  type TestPostgresDriver,
  withDisposablePostgres,
} from "./test-postgres.js";

class RecordingPostgresDriver implements TestPostgresDriver {
  readonly events: string[] = [];

  constructor(private readonly onStop?: () => void | Promise<void>) {}

  async run(): Promise<void> {
    this.events.push("postgres:run");
  }

  async port(): Promise<string> {
    this.events.push("postgres:port");
    return "127.0.0.1:49175\n";
  }

  async inspectHealth(): Promise<"healthy"> {
    this.events.push("postgres:health");
    return "healthy";
  }

  async logs(): Promise<string> {
    this.events.push("postgres:logs");
    return "postgres logs";
  }

  async stop(): Promise<void> {
    await this.onStop?.();
    this.events.push("postgres:stop");
  }
}

type TestSignal = "SIGINT" | "SIGTERM";

class RecordingSignalSource {
  private readonly listeners = new Map<TestSignal, Set<() => void>>();

  on(signal: TestSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: TestSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: TestSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  listenerCount(signal: TestSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "catamorphic-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForProcessIds(
  filePath: string,
  count: number,
): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(filePath, "utf8");
      const ids = text.trim().split(" ").map(Number);
      if (
        text.endsWith("\n") &&
        ids.length === count &&
        ids.every((id) => Number.isSafeInteger(id) && id > 0)
      )
        return ids;
    } catch {
      /* The writer may not have created the marker yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupIsLive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

describe("test process orchestration", () => {
  it("waits for a complete process marker instead of interpreting an empty file as PID zero", async () => {
    const directory = await temporaryDirectory();
    const marker = path.join(directory, "ready");
    await writeFile(marker, "");
    let completed = false;
    const ready = waitForProcessIds(marker, 2).then((ids) => {
      completed = true;
      return ids;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);
    await writeFile(marker, "123 4");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);
    await writeFile(marker, "123 456\n");
    expect(await ready).toEqual([123, 456]);
  });

  it.each([0, -1, NaN, Infinity, 1.5])(
    "rejects unsafe process group ID %s before signaling",
    (id) => {
      const signals = new TestSignalController({
        source: new RecordingSignalSource(),
      });
      try {
        expect(() => signals.activate(id)).toThrow("positive integer");
      } finally {
        signals.close();
      }
    },
  );

  it("plans root script tests before the non-recursive workspace Turbo graph", () => {
    expect(testRunCommands({ rootPath: "/repo", cliArguments: [] })).toEqual([
      {
        label: "root orchestration tests",
        command: "/repo/node_modules/node/bin/node",
        args: [
          "/repo/node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "/repo/vitest.config.ts",
          "--dir",
          "/repo/scripts",
        ],
        logFileName: "root-orchestration-tests.log",
      },
      {
        label: "workspace tests",
        command: "/repo/node_modules/node/bin/node",
        args: [
          "/repo/node_modules/turbo/bin/turbo",
          "run",
          "test",
          "--no-daemon",
          "--force",
          "--concurrency=2",
        ],
        logFileName: "workspace-tests.log",
      },
    ]);
  });

  it("keeps root script tests beside a Turbo dry graph that excludes the root runner", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "..");
    const plan = testRunCommands({
      rootPath: repositoryRoot,
      cliArguments: [],
    });
    const rawGraph = execFileSync(
      path.join(repositoryRoot, "node_modules", "node", "bin", "node"),
      [
        path.join(repositoryRoot, "node_modules", "turbo", "bin", "turbo"),
        "run",
        "test",
        "--dry=json",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const graph: unknown = JSON.parse(rawGraph);
    if (
      typeof graph !== "object" ||
      graph === null ||
      !("tasks" in graph) ||
      !Array.isArray(graph.tasks)
    ) {
      throw new Error("Turbo dry graph did not contain tasks");
    }
    const taskIds = graph.tasks.flatMap((task) =>
      typeof task === "object" &&
      task !== null &&
      "taskId" in task &&
      typeof task.taskId === "string"
        ? [task.taskId]
        : [],
    );

    expect(plan[0]?.label).toBe("root orchestration tests");
    expect(plan[0]?.args.slice(-2)).toEqual([
      "--dir",
      path.join(repositoryRoot, "scripts"),
    ]);
    expect(taskIds.length).toBeGreaterThan(0);
    expect(taskIds).not.toContain("catamorphic#test");
  });

  it("collects only root script tests when another test filename contains scripts", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "..");
    const scriptsRoot = path.join(repositoryRoot, "scripts");
    const command = testRunCommands({
      rootPath: repositoryRoot,
      cliArguments: [],
    })[0];
    if (!command) throw new Error("Root orchestration command was not planned");
    const [vitestPath, _run, ...argumentsAfterRun] = command.args;
    if (!vitestPath) throw new Error("Vitest path was not planned");
    const output = execFileSync(
      command.command,
      [
        vitestPath,
        "list",
        ...argumentsAfterRun,
        "--filesOnly",
        "--staticParse",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const collectedFiles = output.trim().split("\n").filter(Boolean);

    expect(collectedFiles.length).toBeGreaterThan(0);
    expect(collectedFiles).not.toContain(
      "apps/desktop/src/main/usage-transcripts.test.ts",
    );
    for (const file of collectedFiles) {
      expect(
        path.relative(scriptsRoot, path.resolve(repositoryRoot, file)),
      ).not.toMatch(/^\.\.(?:\/|$)/);
    }
  });

  it("limits a full test run to two concurrent Turbo tasks", () => {
    expect(turboTestArguments({ rootPath: "/repo", cliArguments: [] })).toEqual(
      [
        "/repo/node_modules/turbo/bin/turbo",
        "run",
        "test",
        "--no-daemon",
        "--force",
        "--concurrency=2",
      ],
    );
  });

  it("forwards the supported uncached verification argument to Turbo", () => {
    expect(
      turboTestArguments({ rootPath: "/repo", cliArguments: ["--force"] }),
    ).toEqual([
      "/repo/node_modules/turbo/bin/turbo",
      "run",
      "test",
      "--no-daemon",
      "--force",
      "--concurrency=2",
    ]);
  });

  it("rejects unsupported Turbo passthrough arguments", () => {
    expect(() =>
      turboTestArguments({
        rootPath: "/repo",
        cliArguments: ["--filter=@catamorphic/core"],
      }),
    ).toThrow("Unsupported test argument");
  });

  it("runs a successful subprocess before stopping Postgres", async () => {
    const directory = await temporaryDirectory();
    const driver = new RecordingPostgresDriver();
    const signals = new TestSignalController();

    try {
      const result = await withDisposablePostgres({
        driver,
        pid: process.pid,
        nonce: "success",
        task: async () => {
          const processResult = await runLoggedProcess({
            command: process.execPath,
            args: ["-e", 'process.stdout.write("success-output")'],
            cwd: directory,
            env: process.env,
            logPath: path.join(directory, "success.log"),
            signals,
          });
          driver.events.push("process:complete");
          return processResult;
        },
      });

      expect(result).toEqual({ code: 0, signal: null });
      expect(
        await readFile(path.join(directory, "success.log"), "utf8"),
      ).toContain("success-output");
      expect(driver.events.slice(-2)).toEqual([
        "process:complete",
        "postgres:stop",
      ]);
    } finally {
      signals.close();
    }
  });

  it("returns a nonzero subprocess result before stopping Postgres", async () => {
    const directory = await temporaryDirectory();
    const driver = new RecordingPostgresDriver();
    const signals = new TestSignalController();

    try {
      const result = await withDisposablePostgres({
        driver,
        pid: process.pid,
        nonce: "nonzero",
        task: async () => {
          const processResult = await runLoggedProcess({
            command: process.execPath,
            args: [
              "-e",
              'process.stderr.write("failure-output"); process.exitCode = 7',
            ],
            cwd: directory,
            env: process.env,
            logPath: path.join(directory, "nonzero.log"),
            signals,
          });
          driver.events.push("process:complete");
          return processResult;
        },
      });

      expect(result).toEqual({ code: 7, signal: null });
      expect(
        await readFile(path.join(directory, "nonzero.log"), "utf8"),
      ).toContain("failure-output");
      expect(driver.events.slice(-2)).toEqual([
        "process:complete",
        "postgres:stop",
      ]);
    } finally {
      signals.close();
    }
  });

  it("terminates pipe-holding descendants after leader exit before stopping Postgres", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const markerPath = path.join(directory, "orphan.txt");
    const readyPath = path.join(directory, "orphan-ready.txt");
    const terminatedPath = path.join(directory, "orphan-terminated.txt");
    const signals = new TestSignalController();
    let processGroupId: number | undefined;
    const driver = new RecordingPostgresDriver(async () => {
      await access(terminatedPath);
      const [groupId] = await waitForProcessIds(markerPath, 1);
      expect(groupId && processGroupIsLive(groupId)).toBe(false);
    });
    const descendantCode =
      `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(${JSON.stringify(terminatedPath)},"terminated");process.exit(0)});` +
      `require("node:fs").writeFileSync(${JSON.stringify(readyPath)},String(process.pid));setInterval(()=>{},1000)`;

    const operation = withDisposablePostgres({
      driver,
      pid: process.pid,
      nonce: "orphan-descendant",
      task: async () => {
        const result = await runLoggedProcess({
          command: "/bin/sh",
          args: [
            "-c",
            `${process.execPath} -e '${descendantCode}' & while [ ! -f "${readyPath}" ]; do sleep 0.01; done; printf '%s\\n' "$$" > "${markerPath}"; exit 0`,
          ],
          cwd: directory,
          env: process.env,
          logPath: path.join(directory, "orphan.log"),
          signals,
        });
        driver.events.push("process:complete");
        return result;
      },
    });
    const operationOutcome = operation.then(
      (value) => ({ success: true as const, value }),
      (error: unknown) => ({ success: false as const, error }),
    );

    [processGroupId] = await waitForProcessIds(markerPath, 1);
    if (!processGroupId) throw new Error("Missing process group ID");
    const groupId = processGroupId;
    let forcedCleanup = false;
    const fallback = setTimeout(() => {
      forcedCleanup = true;
      try {
        process.kill(-groupId, "SIGTERM");
      } catch {
        // Correct orchestration already terminated the process group.
      }
    }, 500);

    try {
      const outcome = await operationOutcome;
      if (!outcome.success) throw outcome.error;
      expect(outcome.value).toEqual({ code: 0, signal: null });
      expect(forcedCleanup).toBe(false);
      expect(await readFile(terminatedPath, "utf8")).toBe("terminated");
      expect(processGroupIsLive(processGroupId)).toBe(false);
      expect(driver.events.slice(-2)).toEqual([
        "process:complete",
        "postgres:stop",
      ]);
    } finally {
      clearTimeout(fallback);
      signals.close();
      if (processGroupIsLive(processGroupId)) {
        process.kill(-processGroupId, "SIGKILL");
      }
    }
  });

  it("bounds output draining when a descendant escapes the original process group", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const marker = path.join(directory, "escaped.txt");
    const signals = new TestSignalController({
      source: new RecordingSignalSource(),
    });
    const childCode = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\n");setInterval(()=>{},1000)`;
    const operation = runLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{detached:true,stdio:["ignore",1,2]});child.unref()`,
      ],
      cwd: directory,
      env: process.env,
      logPath: path.join(directory, "escaped.log"),
      signals,
    });
    const outcome = operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    const [escapedPid] = await waitForProcessIds(marker, 1);
    if (!escapedPid) throw new Error("Missing escaped PID");
    try {
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("left output pipes open"),
      });
    } finally {
      signals.close();
      if (processIsLive(escapedPid)) process.kill(escapedPid, "SIGTERM");
    }
  });

  it("cleans Postgres and preserves diagnostics when the executable is missing", async () => {
    const directory = await temporaryDirectory();
    const logPath = path.join(directory, "missing.log");
    const driver = new RecordingPostgresDriver();
    const signals = new TestSignalController();

    try {
      let failure: unknown;
      try {
        await withDisposablePostgres({
          driver,
          pid: process.pid,
          nonce: "missing-executable",
          task: async () => {
            await runLoggedProcess({
              command: path.join(directory, "does-not-exist"),
              args: [],
              cwd: directory,
              env: process.env,
              logPath,
              signals,
            });
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(
        typeof failure === "object" &&
          failure !== null &&
          "code" in failure &&
          failure.code,
      ).toBe("ENOENT");
      expect(
        driver.events.filter((event) => event === "postgres:stop"),
      ).toEqual(["postgres:stop"]);
      expect(await readFile(logPath, "utf8")).toContain("does-not-exist");
    } finally {
      signals.close();
    }
  });

  it("keeps signal handlers installed after the first forwarded signal", () => {
    const before = new Set(process.rawListeners("SIGTERM"));
    const signals = new TestSignalController();
    const installed = process
      .rawListeners("SIGTERM")
      .find((listener) => !before.has(listener));
    if (!installed) throw new Error("SIGTERM handler was not installed");

    try {
      installed("SIGTERM");
      expect(process.rawListeners("SIGTERM")).toContain(installed);
      installed("SIGTERM");
      expect(process.rawListeners("SIGTERM")).toContain(installed);
    } finally {
      signals.close();
    }
  });

  it("forwards repeated signals once, terminates descendants, then stops Postgres", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const markerPath = path.join(directory, "processes.txt");
    const signalSource = new RecordingSignalSource();
    const signals = new TestSignalController({ source: signalSource });
    let descendantPid = 0;
    const driver = new RecordingPostgresDriver(() => {
      expect(processIsLive(descendantPid)).toBe(false);
    });

    const operation = withDisposablePostgres({
      driver,
      pid: process.pid,
      nonce: "signal",
      task: async () =>
        runLoggedProcess({
          command: "/bin/sh",
          args: [
            "-c",
            `sleep 30 & child=$!; printf '%s %s\\n' "$$" "$child" > "${markerPath}"; wait "$child"`,
          ],
          cwd: directory,
          env: process.env,
          logPath: path.join(directory, "signal.log"),
          signals,
        }),
    });

    const [processGroupId, childId] = await waitForProcessIds(markerPath, 2);
    if (!processGroupId || !childId) throw new Error("Missing process IDs");
    descendantPid = childId;
    const fallback = setTimeout(() => {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The desired signal path already terminated the group.
      }
    }, 1_000);

    try {
      signalSource.emit("SIGTERM");
      signalSource.emit("SIGTERM");
      expect(signalSource.listenerCount("SIGTERM")).toBe(1);

      await expect(operation).resolves.toEqual({
        code: 143,
        signal: "SIGTERM",
      });
      expect(processIsLive(descendantPid)).toBe(false);
      expect(
        driver.events.filter((event) => event === "postgres:stop"),
      ).toEqual(["postgres:stop"]);
    } finally {
      clearTimeout(fallback);
      signals.close();
      if (processIsLive(processGroupId)) {
        process.kill(-processGroupId, "SIGKILL");
      }
    }
  });

  it("assigns private temp and cache directories to the test environment", async () => {
    const resources = await createTestRunResources({
      pid: process.pid,
      nonce: "private-environment",
    });
    temporaryDirectories.push(resources.rootPath);

    const environment = testRunEnvironment({
      source: { PATH: "/usr/bin" },
      resources,
    });

    expect(environment).toMatchObject({
      TMPDIR: resources.tempPath,
      TMP: resources.tempPath,
      TEMP: resources.tempPath,
      BUN_INSTALL_CACHE_DIR: resources.bunCachePath,
      TURBO_CACHE_DIR: resources.turboCachePath,
      XDG_CACHE_HOME: resources.xdgCachePath,
      TURBO_TELEMETRY_DISABLED: "1",
    });
    expect(
      testRunEnvironment({
        source: { TURBO_CACHE_DIR: "/shared-cache" },
        resources,
      }).TURBO_CACHE_DIR,
    ).toBe(resources.turboCachePath);
    expect(
      testRunEnvironment({
        source: {
          GITHUB_ACTIONS: "true",
          TURBO_CACHE_DIR: "/runner/.turbo/cache",
        },
        resources,
      }).TURBO_CACHE_DIR,
    ).toBe("/runner/.turbo/cache");
    await Promise.all(
      [
        resources.tempPath,
        resources.bunCachePath,
        resources.turboCachePath,
        resources.xdgCachePath,
        resources.logsPath,
      ].map((directory) => access(directory)),
    );
  });

  it("keeps the temp root short enough for Chromium singleton sockets", async () => {
    const resources = await createTestRunResources({
      pid: 123_456_789,
      nonce: "a".repeat(128),
    });
    temporaryDirectories.push(resources.rootPath);

    expect(path.relative(tmpdir(), resources.rootPath)).toMatch(
      /^ct-[A-Za-z0-9]{6}$/,
    );
  });
});
