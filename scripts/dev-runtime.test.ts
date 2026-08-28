import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reserveLoopbackPort } from "./dev.js";
import { acquireDevInstanceLock, stopDevProcessGroup } from "./dev-runtime.js";

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
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
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
});
