import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
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
  const planInput = {
    rootPath,
    tempPath,
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
    const allocatorLock = await acquireDevPortAllocatorLock({
      lockPath: allocatorLockPath,
      pid: process.pid,
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
    }
  } else {
    const instanceLock = await acquireDevInstanceLock({
      lockPath: placeholderPlan.lockPath,
      pid: process.pid,
    });
    const runtime = toolRuntime({ rootPath, env: process.env });
    let activeProcessGroupId: number | undefined;
    let forwardedSignal: NodeJS.Signals | undefined;
    let stopping: Promise<void> | undefined;
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
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
      const started = await runDevStartupAttempts({
        maxAttempts: DEV_STARTUP_ATTEMPTS,
        allocate: async ({ excludedPorts }) => {
          const allocatorLock = await acquireDevPortAllocatorLock({
            lockPath: allocatorLockPath,
            pid: process.pid,
          });
          try {
            const ports = await reserveDevPorts({
              reservePort: reserveLoopbackPort,
              excludedPorts,
            });
            const allocation: DevPortAllocation = {
              ports,
              bindProcessGroup: (processGroupId) =>
                allocatorLock.bindProcessGroup(processGroupId),
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
            await allocation.bindProcessGroup(processGroupId);
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
              await terminateDevProcessGroup({ processGroupId });
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
      try {
        if (stopping) {
          await stopping;
        } else if (activeProcessGroupId !== undefined) {
          await terminateDevProcessGroup({
            processGroupId: activeProcessGroupId,
          });
        }
      } finally {
        await instanceLock.release();
      }
    }
  }
}
