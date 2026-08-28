import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDevPlan, type DevTarget } from "./dev-plan.js";
import {
  acquireDevInstanceLock,
  settleDevProcessGroup,
} from "./dev-runtime.js";
import { toolRuntime } from "./tool-runtime.js";

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

if (import.meta.main) {
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
  const planInput = {
    rootPath,
    tempPath: tmpdir(),
    ...(process.env.CATAMORPHIC_DEV_INSTANCE
      ? { instanceOverride: process.env.CATAMORPHIC_DEV_INSTANCE }
      : {}),
    target,
  };
  const placeholderPlan = createDevPlan({
    ...planInput,
    ports: { desktopCdp: 0, desktopVite: 0, server: 0, operator: 0 },
  });

  if (printOnly) {
    const [desktopCdp, desktopVite, server, operator] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    const plan = createDevPlan({
      ...planInput,
      ports: { desktopCdp, desktopVite, server, operator },
    });
    console.log(JSON.stringify(plan, null, 2));
  } else {
    const lock = await acquireDevInstanceLock({
      lockPath: placeholderPlan.lockPath,
      pid: process.pid,
    });
    let lockSettled = false;
    let processGroupId: number | undefined;
    let stopping: Promise<void> | undefined;
    try {
      const [desktopCdp, desktopVite, server, operator] = await Promise.all([
        reserveLoopbackPort(),
        reserveLoopbackPort(),
        reserveLoopbackPort(),
        reserveLoopbackPort(),
      ]);
      const plan = createDevPlan({
        ...planInput,
        ports: { desktopCdp, desktopVite, server, operator },
      });
      console.log(`Catamorphic development instance: ${plan.instance}`);
      console.log(`  Desktop data: ${plan.desktopDataDir}`);
      console.log(`  Server data:  ${plan.serverDataDir}`);
      console.log(`  Renderer:     http://127.0.0.1:${desktopVite}`);
      console.log(`  CDP:          http://127.0.0.1:${desktopCdp}`);
      console.log(`  Public API:   ${plan.env.CATAMORPHIC_PUBLIC_URL}/api`);
      console.log(
        `  Operator:     http://127.0.0.1:${operator}/_catamorphic/operator`,
      );

      const runtime = toolRuntime({ rootPath, env: process.env });
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
          detached: process.platform !== "win32",
          env: childEnv,
          stdio: "inherit",
        },
      );
      if (!child.pid) throw new Error("Turbo did not start with a process ID");
      const childProcessGroupId = child.pid;
      processGroupId = childProcessGroupId;
      let forwardedSignal: NodeJS.Signals | undefined;
      const forwardSignal = (signal: NodeJS.Signals): void => {
        if (stopping) return;
        forwardedSignal = signal;
        stopping = settleDevProcessGroup({
          processGroupId: childProcessGroupId,
          signal,
          lock,
        });
      };
      const onSigint = () => forwardSignal("SIGINT");
      const onSigterm = () => forwardSignal("SIGTERM");
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (stopping) {
        await stopping;
      } else {
        await settleDevProcessGroup({
          processGroupId: childProcessGroupId,
          lock,
        });
      }
      lockSettled = true;
      process.exitCode =
        result.code ??
        (forwardedSignal === "SIGINT" || result.signal === "SIGINT"
          ? 130
          : 143);
    } finally {
      if (!lockSettled) {
        try {
          if (stopping) {
            await stopping;
          } else if (processGroupId) {
            await settleDevProcessGroup({ processGroupId, lock });
          } else {
            await lock.release();
          }
        } finally {
          lockSettled = true;
        }
      }
    }
  }
}
