import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRunResources,
  runLoggedProcess,
  TestSignalController,
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

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
  it("limits a full test run to two concurrent Turbo tasks", () => {
    expect(turboTestArguments({ rootPath: "/repo", cliArguments: [] })).toEqual(
      [
        "/repo/node_modules/turbo/bin/turbo",
        "run",
        "test",
        "--no-daemon",
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
      "--concurrency=2",
      "--force",
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
    let processGroupId = 0;
    const driver = new RecordingPostgresDriver(async () => {
      await access(terminatedPath);
      expect(processGroupIsLive(processGroupId)).toBe(false);
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
            `${process.execPath} -e '${descendantCode}' & while [ ! -f "${readyPath}" ]; do sleep 0.01; done; printf '%s' "$$" > "${markerPath}"; exit 0`,
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

    processGroupId = Number(await waitForFile(markerPath));
    let forcedCleanup = false;
    const fallback = setTimeout(() => {
      forcedCleanup = true;
      try {
        process.kill(-processGroupId, "SIGTERM");
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
      installed();
      expect(process.rawListeners("SIGTERM")).toContain(installed);
      installed();
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
            `sleep 30 & child=$!; printf '%s %s' "$$" "$child" > "${markerPath}"; wait "$child"`,
          ],
          cwd: directory,
          env: process.env,
          logPath: path.join(directory, "signal.log"),
          signals,
        }),
    });

    const [groupText, descendantText] = (await waitForFile(markerPath)).split(
      " ",
    );
    const processGroupId = Number(groupText);
    descendantPid = Number(descendantText);
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
});
