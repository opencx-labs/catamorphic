import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export interface DevInstanceLock {
  release(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function parseLockOwner(raw: string): { pid: number; token?: string } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("pid" in value)) {
      return null;
    }
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
      return null;
    }
    const token = "token" in value ? value.token : undefined;
    return typeof token === "string"
      ? { pid: value.pid, token }
      : { pid: value.pid };
  } catch {
    return null;
  }
}

function processIsLive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

export async function acquireDevInstanceLock(input: {
  lockPath: string;
  pid: number;
}): Promise<DevInstanceLock> {
  await mkdir(path.dirname(input.lockPath), { recursive: true });

  while (true) {
    const token = randomUUID();
    try {
      const handle = await open(input.lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: input.pid, token })}\n`,
        );
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          let owner: { pid: number; token?: string } | null;
          try {
            owner = parseLockOwner(await readFile(input.lockPath, "utf8"));
          } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw error;
          }
          if (owner?.pid !== input.pid || owner.token !== token) return;
          try {
            await unlink(input.lockPath);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    let owner: { pid: number; token?: string } | null = null;
    try {
      owner = parseLockOwner(await readFile(input.lockPath, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (owner && processIsLive(owner.pid)) {
      throw new Error(
        `Development instance lock ${input.lockPath} is held by live PID ${owner.pid}. Stop that process or set CATAMORPHIC_DEV_INSTANCE to use another instance.`,
      );
    }
    try {
      await unlink(input.lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

function processGroupIsLive(processGroupId: number): boolean {
  try {
    process.kill(
      process.platform === "win32" ? processGroupId : -processGroupId,
      0,
    );
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
    process.kill(
      process.platform === "win32" ? processGroupId : -processGroupId,
      signal,
    );
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

export async function stopDevProcessGroup(input: {
  processGroupId: number;
  signal: NodeJS.Signals;
  lock: DevInstanceLock;
}): Promise<void> {
  try {
    signalProcessGroup(input.processGroupId, input.signal);
    while (processGroupIsLive(input.processGroupId)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await input.lock.release();
  }
}
