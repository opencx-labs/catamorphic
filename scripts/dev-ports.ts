import { connect } from "node:net";
import path from "node:path";
import type { DevPorts, DevTarget } from "./dev-plan.js";

const PORT_ALLOCATION_LIMIT = 256;

export interface DevPortAllocation {
  ports: DevPorts;
  release(): Promise<void>;
}

export interface DevChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class DevStartupAttemptError extends Error {}

export function devPortAllocatorLockPath(input: { tempPath: string }): string {
  return path.join(input.tempPath, "catamorphic-dev", "port-allocation.lock");
}

export function devListenerPorts(input: {
  target: DevTarget;
  ports: DevPorts;
}): number[] {
  const desktop = [input.ports.desktopCdp, input.ports.desktopVite];
  const server = [input.ports.server, input.ports.operator];
  if (input.target === "desktop") return desktop;
  if (input.target === "server") return server;
  return [...desktop, ...server];
}

export async function reserveDevPorts(input: {
  reservePort(): Promise<number>;
  excludedPorts?: ReadonlySet<number>;
}): Promise<DevPorts> {
  const used = new Set(input.excludedPorts);
  const next = async (): Promise<number> => {
    for (let attempt = 0; attempt < PORT_ALLOCATION_LIMIT; attempt += 1) {
      const port = await input.reservePort();
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid reserved development port: ${port}`);
      }
      if (used.has(port)) continue;
      used.add(port);
      return port;
    }
    throw new Error("Could not reserve a distinct development port");
  };
  return {
    desktopCdp: await next(),
    desktopVite: await next(),
    server: await next(),
    operator: await next(),
  };
}

function loopbackPortIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (listening: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function earlyExitError(result: DevChildExit): DevStartupAttemptError {
  return new DevStartupAttemptError(
    `Development process exited before listeners were ready (code=${String(
      result.code,
    )}, signal=${String(result.signal)})`,
  );
}

export async function waitForDevListeners(input: {
  target: DevTarget;
  ports: DevPorts;
  childExit: Promise<DevChildExit>;
  timeoutMs?: number;
  stabilityMs?: number;
}): Promise<void> {
  const listenerPorts = devListenerPorts(input);
  const timeoutMs = input.timeoutMs ?? 60_000;
  const stabilityMs = input.stabilityMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const earlyExit = input.childExit.then(
    (result) => ({ kind: "exit" as const, result }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  while (Date.now() < deadline) {
    const state = await Promise.race([
      earlyExit,
      Promise.all(listenerPorts.map(loopbackPortIsListening)).then(
        (listening) => ({ kind: "listeners" as const, listening }),
      ),
    ]);
    if (state.kind === "exit") throw earlyExitError(state.result);
    if (state.kind === "error") {
      throw new DevStartupAttemptError(
        `Development process failed before listeners were ready: ${
          state.error instanceof Error
            ? state.error.message
            : String(state.error)
        }`,
        { cause: state.error },
      );
    }
    if (state.listening.every(Boolean)) {
      const stable = await Promise.race([
        earlyExit,
        wait(stabilityMs).then(() => ({ kind: "stable" as const })),
      ]);
      if (stable.kind === "exit") throw earlyExitError(stable.result);
      if (stable.kind === "error") {
        throw new DevStartupAttemptError(
          `Development process failed while listeners stabilized: ${
            stable.error instanceof Error
              ? stable.error.message
              : String(stable.error)
          }`,
          { cause: stable.error },
        );
      }
      return;
    }
    const next = await Promise.race([
      earlyExit,
      wait(20).then(() => ({ kind: "continue" as const })),
    ]);
    if (next.kind === "exit") throw earlyExitError(next.result);
    if (next.kind === "error") {
      throw new DevStartupAttemptError(
        `Development process failed before listeners were ready: ${
          next.error instanceof Error ? next.error.message : String(next.error)
        }`,
        { cause: next.error },
      );
    }
  }
  throw new DevStartupAttemptError(
    `Development listeners were not ready within ${timeoutMs}ms: ${listenerPorts.join(", ")}`,
  );
}

export async function runDevStartupAttempts<T>(input: {
  maxAttempts: number;
  allocate(input: {
    excludedPorts: ReadonlySet<number>;
  }): Promise<DevPortAllocation>;
  start(input: { attempt: number; allocation: DevPortAllocation }): Promise<T>;
}): Promise<T> {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("Development startup attempts must be a positive integer");
  }
  const excludedPorts = new Set<number>();
  let lastError: DevStartupAttemptError | undefined;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const allocation = await input.allocate({ excludedPorts });
    for (const port of Object.values(allocation.ports)) {
      excludedPorts.add(port);
    }
    try {
      return await input.start({ attempt, allocation });
    } catch (error) {
      if (!(error instanceof DevStartupAttemptError)) throw error;
      lastError = error;
    } finally {
      await allocation.release();
    }
  }
  throw lastError ?? new Error("Development startup did not run");
}
