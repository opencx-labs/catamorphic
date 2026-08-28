import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
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

async function publishAtomicFile(input: {
  targetPath: string;
  content: string;
  token: string;
}): Promise<boolean> {
  const candidatePath = `${input.targetPath}.candidate-${input.token}`;
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(input.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(candidatePath, input.targetPath);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

function contentIdentity(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

async function claimStaleLock(input: {
  lockPath: string;
  staleContent: string;
  pid: number;
}): Promise<boolean> {
  let generation = contentIdentity(input.staleContent);
  while (true) {
    const token = randomUUID();
    const claimPath = `${input.lockPath}.reclaim-${generation}`;
    if (
      await publishAtomicFile({
        targetPath: claimPath,
        content: `${JSON.stringify({ pid: input.pid, token })}\n`,
        token,
      })
    ) {
      return true;
    }

    let claimContent: string;
    try {
      claimContent = await readFile(claimPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const owner = parseLockOwner(claimContent);
    if (owner && processIsLive(owner.pid)) return false;
    generation = contentIdentity(`${generation}\0${claimContent}`);
  }
}

export async function acquireDevInstanceLock(input: {
  lockPath: string;
  pid: number;
}): Promise<DevInstanceLock> {
  await mkdir(path.dirname(input.lockPath), { recursive: true });
  const token = randomUUID();
  const content = `${JSON.stringify({ pid: input.pid, token })}\n`;

  while (true) {
    if (
      await publishAtomicFile({
        targetPath: input.lockPath,
        content,
        token,
      })
    ) {
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
    }

    let staleContent: string;
    try {
      staleContent = await readFile(input.lockPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const owner = parseLockOwner(staleContent);
    if (owner && processIsLive(owner.pid)) {
      throw new Error(
        `Development instance lock ${input.lockPath} is held by live PID ${owner.pid}. Stop that process or set CATAMORPHIC_DEV_INSTANCE to use another instance.`,
      );
    }
    if (
      !(await claimStaleLock({
        lockPath: input.lockPath,
        staleContent,
        pid: input.pid,
      }))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }

    let currentContent: string;
    try {
      currentContent = await readFile(input.lockPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (currentContent !== staleContent) continue;
    const currentOwner = parseLockOwner(currentContent);
    if (currentOwner && processIsLive(currentOwner.pid)) continue;
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
  await settleDevProcessGroup(input);
}

export async function settleDevProcessGroup(input: {
  processGroupId: number;
  signal?: NodeJS.Signals;
  lock: DevInstanceLock;
}): Promise<void> {
  try {
    signalProcessGroup(input.processGroupId, input.signal ?? "SIGTERM");
    while (processGroupIsLive(input.processGroupId)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await input.lock.release();
  }
}
