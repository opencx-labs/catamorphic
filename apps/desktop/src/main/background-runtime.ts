import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";

export const BACKGROUND_RUNTIME_ARGUMENT = "--background-runtime";
const recordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string(),
});
const commandSchema = z.object({
  token: z.string().max(128),
  command: z.enum(["inspect", "shutdown"]),
});

/** A helper never inherits debug ports or Node's executable override. */
export function backgroundLaunchArguments(args: readonly string[]): string[] {
  return [
    ...args.filter(
      (arg) =>
        arg !== BACKGROUND_RUNTIME_ARGUMENT &&
        !/^--(?:remote-debugging(?:-[a-z-]+)?|remote-allow-origins|inspect(?:-brk)?)(?:=|$)/.test(
          arg,
        ),
    ),
    BACKGROUND_RUNTIME_ARGUMENT,
  ];
}

export function backgroundRuntimeAllowed(env: NodeJS.ProcessEnv): boolean {
  // A normal E2E Quit must leave no helper behind. This explicit opt-in is only
  // useful with the harness's throwaway data directory and isolated display.
  return (
    !env.CATAMORPHIC_E2E_DATA_DIR ||
    env.CATAMORPHIC_E2E_BACKGROUND_RUNTIME === "1"
  );
}

/**
 * Transfer starts only after every foreground cleanup, including the DB flush,
 * succeeded. Tests exercise this boundary with two real independent processes.
 */
export async function handOffBackgroundRuntime(input: {
  shutdown: () => Promise<void>;
  enabled: boolean;
  allowed: boolean;
  releaseLock: () => void;
  launch: () => Promise<unknown>;
}): Promise<void> {
  await input.shutdown();
  if (!input.enabled || !input.allowed) return;
  input.releaseLock();
  await input.launch();
}

/** Same signed application, a new OS process, with no renderer or UI window. */
export function launchBackgroundRuntime(input: {
  executable: string;
  args: readonly string[];
  userData: string;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}): Promise<ChildProcess> {
  fs.mkdirSync(input.userData, { recursive: true });
  const log = fs.openSync(
    path.join(input.userData, "background-runtime.log"),
    "a",
    0o600,
  );
  const env = { ...(input.env ?? process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = (() => {
    try {
      return spawn(input.executable, backgroundLaunchArguments(input.args), {
        cwd: input.userData,
        env,
        detached: true,
        stdio: ["ignore", log, log],
      });
    } finally {
      fs.closeSync(log);
    }
  })();
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(input.userData, () => ready());
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      failed(
        new Error(
          "Work's background runtime did not become ready. Check background-runtime.log.",
        ),
      );
    }, input.readyTimeoutMs ?? 60_000);
    const cleanup = () => {
      clearTimeout(timer);
      watcher.close();
      child.off("error", failed);
      child.off("exit", exited);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null) => {
      // A new foreground launch may win the single-instance lock, or all work
      // may have been disabled during transfer. Both are clean cancellations.
      if (code === 0) {
        cleanup();
        resolve(child);
        return;
      }
      failed(
        new Error(
          `Work's background runtime stopped before it was ready (${code}). Check background-runtime.log.`,
        ),
      );
    };
    const ready = () => {
      try {
        const record = recordSchema.parse(
          JSON.parse(
            fs.readFileSync(
              path.join(input.userData, "background-runtime.json"),
              "utf8",
            ),
          ),
        );
        if (record.pid !== child.pid) return;
        cleanup();
        child.unref();
        resolve(child);
      } catch {
        /* Boot has not written its own control record yet. */
      }
    };
    child.once("error", failed);
    child.once("exit", exited);
    watcher.on("error", failed);
    child.once("spawn", ready);
  });
}

/**
 * Local host control, not a guest API. The random token is private to the host
 * data directory, never a process argv, environment variable or web response.
 */
export async function serveBackgroundRuntime(input: {
  userData: string;
  inspect: () => Promise<unknown>;
  shutdown: () => void;
}): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > 4096) {
        socket.destroy();
        return;
      }
      if (!text.includes("\n")) return;
      socket.pause();
      const parsed = (() => {
        try {
          return commandSchema.safeParse(
            JSON.parse(text.slice(0, text.indexOf("\n"))),
          );
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success) {
        socket.destroy();
        return;
      }
      const given = Buffer.from(parsed.data.token);
      const expected = Buffer.from(token);
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        socket.destroy();
        return;
      }
      if (parsed.data.command === "shutdown") {
        socket.end(`${JSON.stringify({ stopping: true })}\n`, () =>
          input.shutdown(),
        );
      } else {
        void input.inspect().then(
          (value) => socket.end(`${JSON.stringify(value)}\n`),
          () =>
            socket.end(
              `${JSON.stringify({ error: "Background inspection failed." })}\n`,
            ),
        );
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Background control could not listen.");
  const file = path.join(input.userData, "background-runtime.json");
  const record = {
    pid: process.pid,
    port: address.port,
    token,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      // A newer helper's control record is never removed by an older owner.
      try {
        const saved = recordSchema.parse(
          JSON.parse(fs.readFileSync(file, "utf8")),
        );
        if (saved.token === token) fs.unlinkSync(file);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    },
  };
}

export async function callBackgroundRuntime(input: {
  userData: string;
  command: "inspect" | "shutdown";
}): Promise<unknown> {
  const record = recordSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(input.userData, "background-runtime.json"),
        "utf8",
      ),
    ),
  );
  return new Promise((resolve, reject) => {
    const socket = net.connect(record.port, "127.0.0.1");
    socket.setTimeout(5_000, () =>
      socket.destroy(new Error("Background runtime did not answer.")),
    );
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ token: record.token, command: input.command })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 4 * 1024 * 1024)
        socket.destroy(new Error("Background response is too large."));
      else if (response.includes("\n")) {
        try {
          resolve(JSON.parse(response.slice(0, response.indexOf("\n"))));
        } catch (error) {
          reject(error);
        }
        socket.destroy();
      }
    });
    socket.once("close", () => {
      if (!response.includes("\n"))
        reject(new Error("Background runtime closed without an answer."));
    });
  });
}
