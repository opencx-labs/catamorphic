import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deterministicTestEnvironment,
  dockerTestPostgresDriver,
  withDisposablePostgres,
} from "./test-postgres.js";
import { toolRuntime } from "./tool-runtime.js";

const TURBO_CONCURRENCY = 4;
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
  return process.platform === "win32" ? processGroupId : -processGroupId;
}

function processGroupIsLive(processGroupId: number): boolean {
  try {
    process.kill(processGroupTarget(processGroupId), 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(processGroupTarget(processGroupId), signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleProcessGroup(input: {
  processGroupId: number;
  signal: NodeJS.Signals;
}): Promise<void> {
  if (!processGroupIsLive(input.processGroupId)) return;
  signalProcessGroup(input.processGroupId, input.signal);
  const deadline = Date.now() + PROCESS_GROUP_GRACE_MS;
  while (processGroupIsLive(input.processGroupId) && Date.now() < deadline) {
    await delay(20);
  }
  if (!processGroupIsLive(input.processGroupId)) return;
  signalProcessGroup(input.processGroupId, "SIGKILL");
  while (processGroupIsLive(input.processGroupId)) {
    await delay(20);
  }
}

export class TestSignalController {
  private activeProcessGroupId: number | undefined;
  private forwardedSignal: NodeJS.Signals | undefined;
  private readonly source: TestSignalSource;
  private readonly onSigint = () => this.forward("SIGINT");
  private readonly onSigterm = () => this.forward("SIGTERM");

  constructor(input: { source?: TestSignalSource } = {}) {
    this.source = input.source ?? process;
    this.source.on("SIGINT", this.onSigint);
    this.source.on("SIGTERM", this.onSigterm);
  }

  get signal(): NodeJS.Signals | undefined {
    return this.forwardedSignal;
  }

  activate(processGroupId: number): void {
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
    if (this.activeProcessGroupId) {
      signalProcessGroup(this.activeProcessGroupId, signal);
    }
  }
}

export async function createTestRunResources(input: {
  pid: number;
  nonce: string;
}): Promise<TestRunResources> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `catamorphic-test-${input.pid}-${input.nonce}-`),
  );
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
    TURBO_CACHE_DIR: input.resources.turboCachePath,
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
}): Promise<ProcessResult> {
  if (input.signals.signal) {
    return {
      code: input.signals.signal === "SIGINT" ? 130 : 143,
      signal: input.signals.signal,
    };
  }
  const log = createWriteStream(input.logPath, { flags: "wx", mode: 0o600 });
  log.write(`$ ${input.command} ${input.args.join(" ")}\n`);
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    detached: process.platform !== "win32",
    env: input.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
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
    outcome = { success: true, result: await completion };
  } catch (error) {
    outcome = { success: false, error };
  } finally {
    if (processGroupId) {
      try {
        await settleProcessGroup({
          processGroupId,
          signal: input.signals.signal ?? "SIGTERM",
        });
      } catch (error) {
        cleanupError = error;
      } finally {
        input.signals.clear(processGroupId);
      }
    }
    try {
      await closeLog(log);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (!outcome) throw new Error("Test subprocess did not settle");
  if (!outcome.success) throw outcome.error;
  if (cleanupError !== undefined) throw cleanupError;
  const signal = input.signals.signal ?? outcome.result.signal;
  return {
    code: outcome.result.code ?? (signal === "SIGINT" ? 130 : 143),
    signal,
  };
}

export function turboTestArguments(input: { rootPath: string }): string[] {
  return [
    path.join(input.rootPath, "node_modules", "turbo", "bin", "turbo"),
    "run",
    "test",
    "--no-daemon",
    `--concurrency=${TURBO_CONCURRENCY}`,
  ];
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
        const result = await runLoggedProcess({
          command: runtime.nodePath,
          args: turboTestArguments({ rootPath: repositoryRoot }),
          cwd: repositoryRoot,
          env,
          logPath: path.join(resources.logsPath, "workspace-tests.log"),
          signals,
        });
        exitCode = result.code;
        if (result.code !== 0) {
          throw new Error(`Workspace tests exited with code ${result.code}`);
        }
      },
    });
    succeeded = true;
    exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    signals.close();
    if (succeeded) {
      await rm(resources.rootPath, { recursive: true, force: true });
    } else {
      console.error(`Test diagnostics preserved at ${resources.rootPath}`);
    }
  }
  process.exitCode = exitCode;
}

if (import.meta.main) {
  await main();
}
