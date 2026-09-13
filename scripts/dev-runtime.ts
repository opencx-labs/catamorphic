import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export interface DevInstanceLock {
  bindProcessGroup(processGroupId: number): Promise<void>;
  release(): Promise<void>;
}

export interface DevPortAllocatorLock {
  release(): Promise<void>;
}

interface LockOwner {
  pid: number;
  token?: string;
  processGroupId?: number;
}

class DevLockConflictError extends Error {}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("pid" in value)) {
      return null;
    }
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
      return null;
    }
    const token = "token" in value ? value.token : undefined;
    const processGroupId =
      "processGroupId" in value ? value.processGroupId : undefined;
    if (
      processGroupId !== undefined &&
      (typeof processGroupId !== "number" ||
        !Number.isInteger(processGroupId) ||
        processGroupId <= 0)
    ) {
      return null;
    }
    return {
      pid: value.pid,
      ...(typeof token === "string" ? { token } : {}),
      ...(typeof processGroupId === "number" ? { processGroupId } : {}),
    };
  } catch {
    return null;
  }
}

function lockOwnerIsLive(owner: LockOwner): boolean {
  return (
    processIsLive(owner.pid) ||
    (owner.processGroupId !== undefined &&
      processGroupIsLive(owner.processGroupId))
  );
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
    if (owner && lockOwnerIsLive(owner)) return false;
    generation = contentIdentity(`${generation}\0${claimContent}`);
  }
}

async function replaceOwnedLockContent(input: {
  lockPath: string;
  pid: number;
  token: string;
  content: string;
}): Promise<void> {
  const candidatePath = `${input.lockPath}.update-${randomUUID()}`;
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(input.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let owner: LockOwner | null;
    try {
      owner = parseLockOwner(await readFile(input.lockPath, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new Error(
          `Development lock ${input.lockPath} no longer owns its token`,
        );
      }
      throw error;
    }
    if (owner?.pid !== input.pid || owner.token !== input.token) {
      throw new Error(
        `Development lock ${input.lockPath} no longer owns its token`,
      );
    }
    await rename(candidatePath, input.lockPath);
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

export async function acquireDevPortAllocatorLock(input: {
  lockPath: string;
  pid: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DevPortAllocatorLock> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Development port allocator timeout must be positive");
  }
  const deadline = Date.now() + timeoutMs;
  const aborted = (): Error => {
    const reason = input.signal?.reason;
    return new Error(
      `Stopped waiting for global development port allocator ${input.lockPath}: ${
        reason instanceof Error ? reason.message : String(reason ?? "aborted")
      }`,
      { cause: reason },
    );
  };
  const waitForRetry = async (): Promise<void> => {
    if (input.signal?.aborted) throw aborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for global development port allocator ${input.lockPath}. Another development launcher may still be allocating ports; retry after it reaches readiness or exits.`,
      );
    }
    await new Promise<void>((resolve, reject) => {
      const delayMs = Math.min(10, remainingMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void =>
        input.signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        reject(aborted());
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
    });
  };
  while (true) {
    if (input.signal?.aborted) throw aborted();
    try {
      const lock = await acquireDevInstanceLock(input);
      if (input.signal?.aborted) {
        await lock.release();
        throw aborted();
      }
      return { release: () => lock.release() };
    } catch (error) {
      if (!(error instanceof DevLockConflictError)) throw error;
      await waitForRetry();
    }
  }
}

export async function acquireDevInstanceLock(input: {
  lockPath: string;
  pid: number;
  /** Replace only the dev launcher/process group recorded by this lock. */
  replaceExisting?: boolean;
}): Promise<DevInstanceLock> {
  const stateRoot = path.dirname(input.lockPath);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
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
        async bindProcessGroup(processGroupId) {
          if (released) {
            throw new Error(
              `Development lock ${input.lockPath} no longer owns its token`,
            );
          }
          if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
            throw new Error("Development process group ID must be positive");
          }
          await replaceOwnedLockContent({
            lockPath: input.lockPath,
            pid: input.pid,
            token,
            content: `${JSON.stringify({
              pid: input.pid,
              token,
              processGroupId,
            })}\n`,
          });
        },
        async release() {
          if (released) return;
          released = true;
          let owner: LockOwner | null;
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
    if (owner && lockOwnerIsLive(owner)) {
      if (
        input.replaceExisting &&
        owner.pid !== input.pid &&
        owner.processGroupId !== undefined &&
        processGroupIsLive(owner.processGroupId)
      ) {
        await terminateDevProcessGroup({
          processGroupId: owner.processGroupId,
        });
        // A normal launcher exits when its detached Turbo group exits and
        // releases the lock in `finally`. Never signal an arbitrary PID here:
        // the recorded process group is the boundary that distinguishes these
        // dev servers from E2E apps and every other process in the worktree.
        const gracefulDeadline = Date.now() + 2_000;
        while (processIsLive(owner.pid) && Date.now() < gracefulDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (processIsLive(owner.pid)) {
          throw new DevLockConflictError(
            `Development servers in process group ${owner.processGroupId} stopped, but launcher PID ${owner.pid} did not exit. Stop that launcher before retrying development.`,
          );
        }
        continue;
      }
      if (
        !processIsLive(owner.pid) &&
        owner.processGroupId !== undefined &&
        processGroupIsLive(owner.processGroupId)
      ) {
        throw new DevLockConflictError(
          `Development instance lock ${input.lockPath} is held by live process group ${owner.processGroupId} after launcher PID ${owner.pid} exited. Stop that process group or set CATAMORPHIC_DEV_INSTANCE to use another instance.`,
        );
      }
      throw new DevLockConflictError(
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
    if (currentOwner && lockOwnerIsLive(currentOwner)) continue;
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

async function devProcessGroups(processGroupId: number): Promise<number[]> {
  if (process.platform === "win32") return [processGroupId];
  // Turbo starts each package task in another process group. Snapshot those
  // descendants BEFORE signaling Turbo: after it exits they are reparented,
  // so checking only Turbo's group would declare success and leak Electron.
  const { stdout } = await promisify(execFile)(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid="],
    { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const processes = stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parentPid, groupId] = line.trim().split(/\s+/).map(Number);
      return pid && parentPid !== undefined && groupId
        ? [{ pid, parentPid, groupId }]
        : [];
    });
  const owned = new Set(
    processes
      .filter((item) => item.groupId === processGroupId)
      .map((item) => item.pid),
  );
  let previousSize = -1;
  while (previousSize !== owned.size) {
    previousSize = owned.size;
    for (const item of processes) {
      if (owned.has(item.parentPid)) owned.add(item.pid);
    }
  }
  return [
    ...new Set([
      processGroupId,
      ...processes
        .filter((item) => owned.has(item.pid))
        .map((item) => item.groupId),
    ]),
  ];
}

export async function stopDevProcessGroup(input: {
  processGroupId: number;
  signal: NodeJS.Signals;
  gracePeriodMs?: number;
  killWaitMs?: number;
  lock: DevInstanceLock;
}): Promise<void> {
  await settleDevProcessGroup(input);
}

export async function terminateDevProcessGroup(input: {
  processGroupId: number;
  signal?: NodeJS.Signals;
  gracePeriodMs?: number;
  killWaitMs?: number;
}): Promise<void> {
  if (!processGroupIsLive(input.processGroupId)) return;
  const groups = new Set(await devProcessGroups(input.processGroupId));
  const stillRunning = (): boolean => {
    for (const group of groups) {
      if (!processGroupIsLive(group)) groups.delete(group);
    }
    return groups.size > 0;
  };
  for (const group of groups) {
    signalProcessGroup(group, input.signal ?? "SIGTERM");
  }
  const deadline = Date.now() + (input.gracePeriodMs ?? 5_000);
  while (stillRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const group of groups) {
    signalProcessGroup(group, "SIGKILL");
  }
  const killWaitMs = input.killWaitMs ?? 1_000;
  const killDeadline = Date.now() + killWaitMs;
  while (stillRunning() && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (stillRunning()) {
    throw new Error(
      `Development process groups ${[...groups].join(", ")} remained observable after SIGKILL for ${killWaitMs}ms. Stop them manually before retrying development; the instance lock was retained.`,
    );
  }
}

export async function settleDevProcessGroup(input: {
  processGroupId: number;
  signal?: NodeJS.Signals;
  gracePeriodMs?: number;
  killWaitMs?: number;
  lock: DevInstanceLock;
}): Promise<void> {
  await terminateDevProcessGroup(input);
  await input.lock.release();
}
