import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveLoopbackPort } from "./dev.js";
import {
  acquireDevInstanceLock,
  acquireDevPortAllocatorLock,
  settleDevProcessGroup,
  stopDevProcessGroup,
} from "./dev-runtime.js";

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(() => {
  for (const child of childProcesses.splice(0)) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group has already exited.
      }
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryLockPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "catamorphic-lock-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "instance", "dev.lock");
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processGroupIsLive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

describe("acquireDevInstanceLock", () => {
  it("acquires and releases a worktree instance lock", async () => {
    const lockPath = temporaryLockPath();

    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });

    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expect(statSync(path.dirname(lockPath)).mode & 0o777).toBe(0o700);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("tightens an existing development state root to mode 0700", async () => {
    const lockPath = temporaryLockPath();
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o755 });
    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });

    expect(statSync(path.dirname(lockPath)).mode & 0o777).toBe(0o700);
    await lock.release();
  });

  it("reports an actionable conflict for a live owner", async () => {
    const lockPath = temporaryLockPath();
    const first = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });

    await expect(
      acquireDevInstanceLock({ lockPath, pid: process.pid }),
    ).rejects.toThrow(
      `Development instance lock ${lockPath} is held by live PID ${process.pid}. Stop that process or set CATAMORPHIC_DEV_INSTANCE to use another instance.`,
    );

    await first.release();
  });

  it("reclaims a stale PID lock", async () => {
    const lockPath = temporaryLockPath();
    const stalePid = 2_147_483_647;
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: stalePid, token: "stale" }));

    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });

    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    await lock.release();
  });

  it("allows only one owner during a simultaneous clean start", async () => {
    const lockPath = temporaryLockPath();

    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () =>
        acquireDevInstanceLock({ lockPath, pid: process.pid }),
      ),
    );
    const owners = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    expect(owners).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(31);
    await owners[0]?.release();
  });

  it("allows only one owner during simultaneous stale reclaim", async () => {
    const lockPath = temporaryLockPath();
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () =>
        acquireDevInstanceLock({ lockPath, pid: process.pid }),
      ),
    );
    const owners = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    expect(owners).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(31);
    await owners[0]?.release();
  });

  it("persists the child process group and refuses reclaim after launcher death", async () => {
    if (process.platform === "win32") return;
    const lockPath = temporaryLockPath();
    const readyPath = path.join(path.dirname(lockPath), "group-ready");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const descendantSource = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const launcherSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const launcher = spawn(process.execPath, ["-e", launcherSource], {
      detached: true,
      stdio: "ignore",
    });
    childProcesses.push(launcher);
    await waitForFile(readyPath);
    if (!launcher.pid) throw new Error("Launcher did not receive a PID");
    const processGroupId = launcher.pid;
    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: launcher.pid,
    });
    await lock.bindProcessGroup(processGroupId);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: launcher.pid,
      processGroupId,
    });

    const launcherExit = new Promise<void>((resolve) =>
      launcher.once("exit", () => resolve()),
    );
    process.kill(launcher.pid, "SIGKILL");
    await launcherExit;
    expect(processGroupIsLive(processGroupId)).toBe(true);

    try {
      await expect(
        acquireDevInstanceLock({ lockPath, pid: process.pid }),
      ).rejects.toThrow(`live process group ${processGroupId}`);
    } finally {
      process.kill(-processGroupId, "SIGKILL");
      await lock.release();
    }
  });

  it("does not let a released owner overwrite a replacement lock", async () => {
    const lockPath = temporaryLockPath();
    const first = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });
    await first.release();
    const replacement = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });

    await expect(first.bindProcessGroup(12345)).rejects.toThrow(
      "no longer owns",
    );
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).not.toHaveProperty(
      "processGroupId",
    );
    await replacement.release();
  });
});

describe("reserveLoopbackPort", () => {
  it("returns a numeric port that is available on IPv4 loopback", async () => {
    const port = await reserveLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});

describe("acquireDevPortAllocatorLock", () => {
  it("serializes concurrent allocators through one global critical section", async () => {
    const lockPath = temporaryLockPath();
    let active = 0;
    let maximumActive = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, async (_value, index) => {
        const lock = await acquireDevPortAllocatorLock({
          lockPath,
          pid: process.pid,
        });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(index);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        await lock.release();
      }),
    );

    expect(order).toHaveLength(8);
    expect(maximumActive).toBe(1);
  });

  it("keeps allocator ownership with the launcher and recovers after launcher death", async () => {
    if (process.platform === "win32") return;
    const lockPath = temporaryLockPath();
    const launcher = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const spawnedChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    childProcesses.push(launcher, spawnedChild);
    if (!launcher.pid || !spawnedChild.pid) {
      throw new Error("Allocator recovery fixtures did not receive PIDs");
    }
    const first = await acquireDevPortAllocatorLock({
      lockPath,
      pid: launcher.pid,
      timeoutMs: 250,
    });
    expect("bindProcessGroup" in first).toBe(false);

    const launcherExit = new Promise<void>((resolve) =>
      launcher.once("exit", () => resolve()),
    );
    process.kill(launcher.pid, "SIGKILL");
    await launcherExit;
    expect(processGroupIsLive(spawnedChild.pid)).toBe(true);

    const recovered = await acquireDevPortAllocatorLock({
      lockPath,
      pid: process.pid,
      timeoutMs: 250,
    });
    await recovered.release();
  });

  it("fails actionably after a bounded allocator wait", async () => {
    const lockPath = temporaryLockPath();
    const owner = await acquireDevPortAllocatorLock({
      lockPath,
      pid: process.pid,
      timeoutMs: 250,
    });
    const waiting = acquireDevPortAllocatorLock({
      lockPath,
      pid: process.pid,
      timeoutMs: 25,
    });

    const outcome = await Promise.race([
      waiting.then(
        () => "unexpected acquisition",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("allocator wait did not stop"), 100),
      ),
    ]);
    await owner.release();
    if (outcome === "allocator wait did not stop") {
      await (await waiting).release();
    }

    expect(outcome).toBe(
      `Timed out after 25ms waiting for global development port allocator ${lockPath}. Another development launcher may still be allocating ports; retry after it reaches readiness or exits.`,
    );
  });

  it("aborts an allocator wait on a launcher signal", async () => {
    const lockPath = temporaryLockPath();
    const owner = await acquireDevPortAllocatorLock({
      lockPath,
      pid: process.pid,
      timeoutMs: 250,
    });
    const abort = new AbortController();
    const waiting = acquireDevPortAllocatorLock({
      lockPath,
      pid: process.pid,
      signal: abort.signal,
      timeoutMs: 250,
    });
    abort.abort(new Error("Development startup interrupted by SIGTERM"));

    const outcome = await Promise.race([
      waiting.then(
        () => "unexpected acquisition",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("allocator wait did not abort"), 100),
      ),
    ]);
    await owner.release();
    if (outcome === "allocator wait did not abort") {
      await (await waiting).release();
    }

    expect(outcome).toBe(
      `Stopped waiting for global development port allocator ${lockPath}: Development startup interrupted by SIGTERM`,
    );
  });
});

describe("stopDevProcessGroup", () => {
  it("waits for descendants to exit before releasing the instance lock", async () => {
    const lockPath = temporaryLockPath();
    const readyPath = path.join(path.dirname(lockPath), "ready");
    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });
    const descendantSource = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 10));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const child = spawn(process.execPath, ["-e", leaderSource], {
      detached: true,
      stdio: "ignore",
    });
    childProcesses.push(child);
    await waitForFile(readyPath);
    if (!child.pid) throw new Error("Detached child did not receive a PID");

    let stopped = false;
    const stopping = stopDevProcessGroup({
      processGroupId: child.pid,
      signal: "SIGTERM",
      lock,
    }).then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stopped).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    await stopping;
    expect(existsSync(lockPath)).toBe(false);
  });

  it("terminates a live descendant after the process-group leader exits", async () => {
    const lockPath = temporaryLockPath();
    const readyPath = path.join(path.dirname(lockPath), "orphan-ready");
    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });
    const descendantSource = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      "process.exit(0);",
    ].join("");
    const leader = spawn(process.execPath, ["-e", leaderSource], {
      detached: true,
      stdio: "ignore",
    });
    childProcesses.push(leader);
    const leaderExit = new Promise<void>((resolve, reject) => {
      leader.once("error", reject);
      leader.once("exit", () => resolve());
    });
    await waitForFile(readyPath);
    await leaderExit;
    if (!leader.pid) throw new Error("Detached leader did not receive a PID");

    let settled = false;
    const settling = settleDevProcessGroup({
      processGroupId: leader.pid,
      lock,
    }).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    await settling;
    expect(existsSync(lockPath)).toBe(false);
  });

  it("escalates to SIGKILL when a descendant ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const lockPath = temporaryLockPath();
    const readyPath = path.join(path.dirname(lockPath), "stubborn-ready");
    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });
    const descendantSource = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leader = spawn(process.execPath, ["-e", leaderSource], {
      detached: true,
      stdio: "ignore",
    });
    childProcesses.push(leader);
    await waitForFile(readyPath);
    if (!leader.pid) throw new Error("Detached leader did not receive a PID");
    const processGroupId = leader.pid;
    let fallbackUsed = false;
    const fallback = setTimeout(() => {
      fallbackUsed = true;
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The bounded escalation already terminated the group.
      }
    }, 300);

    try {
      await stopDevProcessGroup({
        processGroupId,
        signal: "SIGTERM",
        gracePeriodMs: 50,
        lock,
      });
      expect(fallbackUsed).toBe(false);
      expect(processGroupIsLive(processGroupId)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      clearTimeout(fallback);
      if (processGroupIsLive(processGroupId)) {
        process.kill(-processGroupId, "SIGKILL");
      }
    }
  });

  it("fails after a bounded SIGKILL wait and retains the PGID safety lock", async () => {
    const lockPath = temporaryLockPath();
    const processGroupId = 2_147_483_646;
    const lock = await acquireDevInstanceLock({
      lockPath,
      pid: process.pid,
    });
    await lock.bindProcessGroup(processGroupId);
    let groupObservable = true;
    const signals: Array<string | number | undefined> = [];
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        signals.push(signal);
        if (signal === 0 && !groupObservable) {
          const error = new Error("gone") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        return true;
      });

    const stopping = settleDevProcessGroup({
      processGroupId,
      signal: "SIGTERM",
      gracePeriodMs: 0,
      killWaitMs: 25,
      lock,
    });
    const outcome = await Promise.race([
      stopping.then(
        () => "unexpected shutdown",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("shutdown did not stop"), 100),
      ),
    ]);
    if (outcome === "shutdown did not stop") {
      groupObservable = false;
      await stopping;
    }

    try {
      expect(outcome).toBe(
        `Development process group ${processGroupId} remained observable after SIGKILL for 25ms. Stop it manually before retrying development; its instance lock was retained.`,
      );
      expect(signals).toContain("SIGTERM");
      expect(signals).toContain("SIGKILL");
      expect(existsSync(lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
        processGroupId,
      });
    } finally {
      kill.mockRestore();
      await lock.release();
    }
  });
});
