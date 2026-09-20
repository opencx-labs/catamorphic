import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { migrateDevData } from "./dev-data.js";
import { createDevPlan, type DevTarget } from "./dev-plan.js";
import {
  type DevChildExit,
  type DevPortAllocation,
  DevStartupAttemptError,
  devPortAllocatorLockPath,
  reserveDevPorts,
  runDevStartupAttempts,
  waitForDevListeners,
} from "./dev-ports.js";
import {
  acquireDevInstanceLock,
  acquireDevPortAllocatorLock,
  terminateDevProcessGroup,
} from "./dev-runtime.js";
import { toolRuntime } from "./tool-runtime.js";

/** The msb binary of the microsandbox SDK the workspace depends on. */
function bundledMsbPath(rootPath: string): string | undefined {
  const triples: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x64-gnu",
    "linux-arm64": "linux-arm64-gnu",
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) return undefined;
  try {
    // The platform package sits beside the SDK, not beside the workspace
    // package that depends on it, so resolve in two hops.
    const sdk = createRequire(
      path.join(rootPath, "packages", "microsandbox", "package.json"),
    ).resolve("microsandbox/package.json");
    const platform = createRequire(sdk).resolve(
      `@superradcompany/microsandbox-${triple}/package.json`,
    );
    const binary = path.join(path.dirname(platform), "bin", "msb");
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

const DEV_STARTUP_ATTEMPTS = 3;

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Loopback port reservation returned no numeric port"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function childExit(child: ChildProcess): Promise<DevChildExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function reportPlan(input: {
  plan: ReturnType<typeof createDevPlan>;
  attempt: number;
}): void {
  const { plan } = input;
  console.log(
    `Catamorphic development instance: ${plan.instance} (startup ${input.attempt}/${DEV_STARTUP_ATTEMPTS})`,
  );
  console.log(`  Desktop data: ${plan.desktopDataDir}`);
  console.log(`  Server data:  ${plan.serverDataDir}`);
  console.log(
    `  Renderer:     http://127.0.0.1:${plan.env.CATAMORPHIC_DESKTOP_VITE_PORT}`,
  );
  console.log(
    `  CDP:          http://127.0.0.1:${plan.env.CATAMORPHIC_DESKTOP_CDP_PORT}`,
  );
  console.log(`  Public API:   ${plan.env.CATAMORPHIC_PUBLIC_URL}/api`);
  console.log(
    `  Operator:     http://127.0.0.1:${plan.env.CATAMORPHIC_OPERATOR_PORT}/_catamorphic/operator`,
  );
}

if (import.meta.main) {
  if (process.platform === "win32") {
    throw new Error(
      "The development runner supports macOS and Linux process groups only",
    );
  }
  const [targetArgument, ...options] = process.argv.slice(2);
  if (
    targetArgument !== "all" &&
    targetArgument !== "desktop" &&
    targetArgument !== "server"
  ) {
    throw new Error("Usage: bun scripts/dev.ts <all|desktop|server> [--print]");
  }
  if (options.some((option) => option !== "--print") || options.length > 1) {
    throw new Error("The only supported development runner option is --print");
  }
  const target: DevTarget = targetArgument;
  const printOnly = options[0] === "--print";
  const rootPath = path.resolve(import.meta.dirname, "..");
  const tempPath = tmpdir();
  const msbPath = bundledMsbPath(rootPath);
  const planInput = {
    rootPath,
    ...(msbPath ? { msbPath } : {}),
    dataPath: path.join(homedir(), ".catamorphic", "dev"),
    ...(process.env.CATAMORPHIC_DEV_INSTANCE
      ? { instanceOverride: process.env.CATAMORPHIC_DEV_INSTANCE }
      : {}),
    target,
  };
  const placeholderPlan = createDevPlan({
    ...planInput,
    ports: { desktopCdp: 1, desktopVite: 2, server: 3, operator: 4 },
  });
  const allocatorLockPath = devPortAllocatorLockPath({ tempPath });

  if (printOnly) {
    const allocatorAbort = new AbortController();
    const abortAllocator = (signal: NodeJS.Signals): void =>
      allocatorAbort.abort(
        new Error(`Development startup interrupted by ${signal}`),
      );
    const onPrintSigint = () => abortAllocator("SIGINT");
    const onPrintSigterm = () => abortAllocator("SIGTERM");
    process.once("SIGINT", onPrintSigint);
    process.once("SIGTERM", onPrintSigterm);
    const allocatorLock = await acquireDevPortAllocatorLock({
      lockPath: allocatorLockPath,
      pid: process.pid,
      signal: allocatorAbort.signal,
    });
    try {
      const ports = await reserveDevPorts({
        reservePort: reserveLoopbackPort,
      });
      console.log(
        JSON.stringify(createDevPlan({ ...planInput, ports }), null, 2),
      );
    } finally {
      await allocatorLock.release();
      process.removeListener("SIGINT", onPrintSigint);
      process.removeListener("SIGTERM", onPrintSigterm);
    }
  } else {
    const instanceLock = await acquireDevInstanceLock({
      lockPath: placeholderPlan.lockPath,
      pid: process.pid,
      replaceExisting: true,
    });
    const runtime = toolRuntime({ rootPath, env: process.env });
    let activeProcessGroupId: number | undefined;
    let forwardedSignal: NodeJS.Signals | undefined;
    let stopping: Promise<void> | undefined;
    const allocatorAbort = new AbortController();
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      allocatorAbort.abort(
        new Error(`Development startup interrupted by ${signal}`),
      );
      if (activeProcessGroupId !== undefined) {
        stopping = terminateDevProcessGroup({
          processGroupId: activeProcessGroupId,
          signal,
        });
      }
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    try {
      await migrateDevData({
        legacyRoot: path.join(
          tempPath,
          "catamorphic-dev",
          placeholderPlan.instance,
        ),
        destinationRoot: path.dirname(placeholderPlan.lockPath),
      });
      const started = await runDevStartupAttempts({
        maxAttempts: DEV_STARTUP_ATTEMPTS,
        allocate: async ({ excludedPorts }) => {
          const allocatorLock = await acquireDevPortAllocatorLock({
            lockPath: allocatorLockPath,
            pid: process.pid,
            signal: allocatorAbort.signal,
          });
          try {
            const ports = await reserveDevPorts({
              reservePort: reserveLoopbackPort,
              excludedPorts,
            });
            const allocation: DevPortAllocation = {
              ports,
              release: () => allocatorLock.release(),
            };
            return allocation;
          } catch (error) {
            await allocatorLock.release();
            throw error;
          }
        },
        start: async ({ attempt, allocation }) => {
          if (forwardedSignal) {
            throw new Error(
              `Development startup interrupted by ${forwardedSignal}`,
            );
          }
          const plan = createDevPlan({
            ...planInput,
            ports: allocation.ports,
          });
          reportPlan({ plan, attempt });
          const childEnv: NodeJS.ProcessEnv = {
            ...runtime.env,
            ...plan.env,
            CATAMORPHIC_DESKTOP_PREVIOUS_DATA_DIR: path.join(
              tempPath,
              "catamorphic-dev",
              plan.instance,
              "desktop",
            ),
          };
          delete childEnv.DATABASE_URL;
          const child = spawn(
            runtime.nodePath,
            [
              path.join(rootPath, "node_modules", "turbo", "bin", "turbo"),
              ...plan.turboArgs,
            ],
            {
              cwd: rootPath,
              detached: true,
              env: childEnv,
              stdio: "inherit",
            },
          );
          const exit = childExit(child);
          if (!child.pid) {
            try {
              await exit;
            } catch (error) {
              throw new DevStartupAttemptError(
                `Development process failed to spawn: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { cause: error },
              );
            }
            throw new DevStartupAttemptError(
              "Development process did not receive a process ID",
            );
          }
          const processGroupId = child.pid;
          activeProcessGroupId = processGroupId;
          try {
            await instanceLock.bindProcessGroup(processGroupId);
            await waitForDevListeners({
              target,
              ports: allocation.ports,
              childExit: exit,
            });
            return { exit, processGroupId };
          } catch (error) {
            if (stopping) {
              await stopping;
            } else {
              stopping = terminateDevProcessGroup({ processGroupId });
              await stopping;
            }
            activeProcessGroupId = undefined;
            stopping = undefined;
            if (forwardedSignal) {
              throw new Error(
                `Development startup interrupted by ${forwardedSignal}`,
                { cause: error },
              );
            }
            throw error;
          }
        },
      });

      const result = await started.exit;
      process.exitCode =
        result.code ??
        (forwardedSignal === "SIGINT" || result.signal === "SIGINT"
          ? 130
          : 143);
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (stopping) {
        await stopping;
      } else if (activeProcessGroupId !== undefined) {
        await terminateDevProcessGroup({
          processGroupId: activeProcessGroupId,
        });
      }
      await instanceLock.release();
    }
  }
}
