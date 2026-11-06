import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { writeCliError } from "./cli-error.js";
import {
  deterministicTestEnvironment,
  dockerTestPostgresDriver,
  withDisposablePostgres,
} from "./test-postgres.js";
import {
  removeTestDirectory,
  settleTestProcesses,
  withTestProcessCleanup,
} from "./test-processes.js";
import { repositoryNodePath, toolRuntime } from "./tool-runtime.js";

const TURBO_CONCURRENCY = 2;
const PROCESS_GROUP_GRACE_MS = 5_000;

export interface TestRunResources {
  rootPath: string;
  tempPath: string;
  bunCachePath: string;
  turboCachePath: string;
  xdgCachePath: string;
  logsPath: string;
}

export interface ProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
}

export interface TestRunCommand {
  label: string;
  command: string;
  args: readonly string[];
  logFileName: string;
}

export interface TestSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function processGroupTarget(processGroupId: number): number {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
    throw new Error("Process group ID must be a positive integer");
  return process.platform === "win32" ? processGroupId : -processGroupId;
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(processGroupTarget(processGroupId), signal);
  } catch (error) {
    // ESRCH: the group is gone. EPERM: on macOS a group whose members are
    // all exiting (zombies not yet reaped) refuses signals; it is on its
    // way out; bounded cleanup verifies that no live members remain.
    const code = errorCode(error);
    const exiting = code === "EPERM" && process.platform === "darwin";
    if (code !== "ESRCH" && !exiting) throw error;
  }
}

export class TestSignalController {
  private activeProcessGroupId: number | undefined;
  private forwardedSignal: NodeJS.Signals | undefined;
  private readonly source: TestSignalSource;
  private readonly onSigint = () => this.forward("SIGINT");
  private readonly onSigterm = () => this.forward("SIGTERM");
  readonly interrupted: Promise<NodeJS.Signals>;
  private resolveInterrupted!: (signal: NodeJS.Signals) => void;

  constructor(input: { source?: TestSignalSource } = {}) {
    this.interrupted = new Promise((resolve) => {
      this.resolveInterrupted = resolve;
    });
    this.source = input.source ?? process;
    this.source.on("SIGINT", this.onSigint);
    this.source.on("SIGTERM", this.onSigterm);
  }

  get signal(): NodeJS.Signals | undefined {
    return this.forwardedSignal;
  }

  activate(processGroupId: number): void {
    processGroupTarget(processGroupId);
    this.activeProcessGroupId = processGroupId;
    if (this.forwardedSignal) {
      signalProcessGroup(processGroupId, this.forwardedSignal);
    }
  }

  clear(processGroupId: number): void {
    if (this.activeProcessGroupId === processGroupId) {
      this.activeProcessGroupId = undefined;
    }
  }

  close(): void {
    this.source.off("SIGINT", this.onSigint);
    this.source.off("SIGTERM", this.onSigterm);
  }

  private forward(signal: NodeJS.Signals): void {
    if (this.forwardedSignal) return;
    this.forwardedSignal = signal;
    this.resolveInterrupted(signal);
    if (this.activeProcessGroupId) {
      signalProcessGroup(this.activeProcessGroupId, signal);
    }
  }
}

export async function createTestRunResources(_input: {
  pid: number;
  nonce: string;
}): Promise<TestRunResources> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "ct-"));
  const resources = {
    rootPath,
    tempPath: path.join(rootPath, "tmp"),
    bunCachePath: path.join(rootPath, "bun-cache"),
    turboCachePath: path.join(rootPath, "turbo-cache"),
    xdgCachePath: path.join(rootPath, "xdg-cache"),
    logsPath: path.join(rootPath, "logs"),
  };
  await Promise.all(
    Object.values(resources)
      .filter((directory) => directory !== rootPath)
      .map((directory) => mkdir(directory, { recursive: true })),
  );
  return resources;
}

export function testRunEnvironment(input: {
  source: NodeJS.ProcessEnv;
  resources: TestRunResources;
}): NodeJS.ProcessEnv {
  return {
    ...input.source,
    TMPDIR: input.resources.tempPath,
    TMP: input.resources.tempPath,
    TEMP: input.resources.tempPath,
    BUN_INSTALL_CACHE_DIR: input.resources.bunCachePath,
    // Hosted CI owns its checkout and can reuse successful tasks. Each
    // invocation still owns its temporary files and disposable database.
    TURBO_CACHE_DIR:
      input.source.GITHUB_ACTIONS === "true"
        ? (input.source.TURBO_CACHE_DIR ?? input.resources.turboCachePath)
        : input.resources.turboCachePath,
    XDG_CACHE_HOME: input.resources.xdgCachePath,
    TURBO_TELEMETRY_DISABLED: "1",
  };
}

function mirrorOutput(input: {
  stream: NodeJS.ReadableStream | null;
  destination: NodeJS.WriteStream;
  log: WriteStream;
}): void {
  input.stream?.on("data", (chunk: Uint8Array) => {
    input.destination.write(chunk);
    input.log.write(chunk);
  });
}

function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    log.once("error", reject);
    log.end(resolve);
  });
}

export async function runLoggedProcess(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  signals: TestSignalController;
  /** This invocation's private temporary directory, never the OS temp root. */
  temporaryRoot?: string;
}): Promise<ProcessResult> {
  if (input.signals.signal) {
    return {
      code: input.signals.signal === "SIGINT" ? 130 : 143,
      signal: input.signals.signal,
    };
  }
  const temporaryRoot = input.temporaryRoot
    ? await realpath(input.temporaryRoot)
    : undefined;
  const log = createWriteStream(input.logPath, { flags: "wx", mode: 0o600 });
  log.write(`$ ${input.command} ${input.args.join(" ")}\n`);
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    detached: process.platform !== "win32",
    env: input.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const exitCompletion = new Promise<
    | {
        success: true;
        result: { code: number | null; signal: NodeJS.Signals | null };
      }
    | { success: false; error: unknown }
  >((resolve) => {
    child.once("error", (error) => resolve({ success: false, error }));
    child.once("exit", (code, signal) =>
      resolve({ success: true, result: { code, signal } }),
    );
  });
  const closeCompletion = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  mirrorOutput({ stream: child.stdout, destination: process.stdout, log });
  mirrorOutput({ stream: child.stderr, destination: process.stderr, log });
  const processGroupId = child.pid;
  let outcome:
    | {
        success: true;
        result: { code: number | null; signal: NodeJS.Signals | null };
      }
    | { success: false; error: unknown }
    | undefined;
  let cleanupError: unknown;
  try {
    if (processGroupId) input.signals.activate(processGroupId);
    outcome = await Promise.race([
      exitCompletion,
      input.signals.interrupted.then(() => undefined),
    ]);
  } finally {
    if (processGroupId) {
      try {
        await settleTestProcesses({
          processGroupId,
          temporaryRoot,
          signal: input.signals.signal ?? "SIGTERM",
        });
      } catch (error) {
        cleanupError = error;
      } finally {
        input.signals.clear(processGroupId);
      }
    }
    if (!outcome) {
      outcome = await new Promise((resolve) => {
        const timeout = setTimeout(
          () =>
            resolve({
              success: false,
              error: new Error("Test phase did not exit after cleanup"),
            }),
          PROCESS_GROUP_GRACE_MS,
        );
        void exitCompletion.then((result) => {
          clearTimeout(timeout);
          resolve(result);
        });
      });
    }
    const closed = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), PROCESS_GROUP_GRACE_MS);
      void closeCompletion.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    if (!closed) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      cleanupError ??= new Error(
        `Test subprocess ${processGroupId} left output pipes open after cleanup`,
      );
    }
    try {
      await closeLog(log);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (!outcome) throw new Error("Test subprocess did not settle");
  if (!outcome.success) {
    if (cleanupError !== undefined)
      throw new AggregateError(
        [outcome.error, cleanupError],
        "Test phase and process cleanup failed",
      );
    throw outcome.error;
  }
  if (cleanupError !== undefined) {
    if (outcome.result.code !== 0 || outcome.result.signal)
      throw new AggregateError(
        [
          new Error(
            `Test phase exited with ${outcome.result.signal ?? outcome.result.code}`,
          ),
          cleanupError,
        ],
        "Test phase and process cleanup failed",
      );
    throw cleanupError;
  }
  const signal = input.signals.signal ?? outcome.result.signal;
  return {
    code:
      outcome.result.code ?? 128 + (signal ? constants.signals[signal] : 15),
    signal,
  };
}

export function turboTestArguments(input: {
  rootPath: string;
  cliArguments: readonly string[];
}): string[] {
  for (const argument of input.cliArguments) {
    if (argument !== "--force") {
      throw new Error(`Unsupported test argument: ${JSON.stringify(argument)}`);
    }
  }
  return [
    path.join(input.rootPath, "node_modules", "turbo", "bin", "turbo"),
    "run",
    "test",
    "--no-daemon",
    "--force",
    `--concurrency=${TURBO_CONCURRENCY}`,
  ];
}

export function testRunCommands(input: {
  rootPath: string;
  cliArguments: readonly string[];
}): TestRunCommand[] {
  const nodePath = repositoryNodePath({ rootPath: input.rootPath });
  return [
    {
      label: "root orchestration tests",
      command: nodePath,
      args: [
        path.join(input.rootPath, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        path.join(input.rootPath, "vitest.config.ts"),
        "--dir",
        path.join(input.rootPath, "scripts"),
      ],
      logFileName: "root-orchestration-tests.log",
    },
    {
      label: "workspace tests",
      command: nodePath,
      args: turboTestArguments(input),
      logFileName: "workspace-tests.log",
    },
  ];
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  let commands: TestRunCommand[];
  try {
    commands = testRunCommands({
      rootPath: repositoryRoot,
      cliArguments: process.argv.slice(2),
    });
  } catch (error) {
    writeCliError(error);
    process.exitCode = 1;
    return;
  }
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
      task: async (databaseUrl) =>
        withTestProcessCleanup(resources.tempPath, async () => {
          const env = testRunEnvironment({
            source: deterministicTestEnvironment(runtime.env, databaseUrl),
            resources,
          });
          for (const [index, command] of commands.entries()) {
            console.log(
              `\n[test ${index + 1}/${commands.length}] ${command.label}`,
            );
            const result = await runLoggedProcess({
              command: command.command,
              args: command.args,
              cwd: repositoryRoot,
              env,
              logPath: path.join(resources.logsPath, command.logFileName),
              signals,
              temporaryRoot: resources.tempPath,
            });
            exitCode = result.code;
            if (result.code !== 0) {
              throw new Error(
                `${command.label} exited with code ${result.code}`,
              );
            }
          }
        }),
    });
    succeeded = true;
    exitCode = 0;
  } catch (error) {
    exitCode = exitCode || 1;
    writeCliError(error);
  } finally {
    signals.close();
    if (succeeded) {
      await removeTestDirectory(resources.rootPath);
    } else {
      console.error(`Test diagnostics preserved at ${resources.rootPath}`);
    }
  }
  process.exitCode = exitCode;
}

if (import.meta.main) {
  await main();
}
