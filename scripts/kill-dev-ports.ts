#!/usr/bin/env bun
/**
 * Pre-dev cleanup: kills any of OUR dev processes left over from a previous
 * `bun run dev` (identified by command pattern AND verified to be bun/next/
 * wrangler/workerd — never random listeners like the editor's live preview
 * server). Idempotent and safe to run even when nothing is listening.
 *
 * Runs automatically via the root `predev` script before `turbo dev`.
 */

import { spawnSync } from "node:child_process";

const PORTS = [8500, 3000, 8787];

const STALE_PROCESS_PATTERNS = [
  "bun --watch --env-file=../../.env src/server.ts",
  "next dev --port 3000",
  "wrangler dev",
];

/**
 * Only processes whose executable name contains one of these tokens are
 * considered "ours" and eligible to be killed when they're holding a dev
 * port. This guards against killing the editor's preview server, a stray
 * Postgres port forward, etc.
 */
const DEV_EXECUTABLE_TOKENS = ["bun", "node", "next", "wrangler", "workerd"];

function commandForPid(pid: number): string | undefined {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (out.status !== 0) return undefined;
  return out.stdout.trim() || undefined;
}

function isDevProcess(pid: number): boolean {
  const cmd = commandForPid(pid);
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  return DEV_EXECUTABLE_TOKENS.some((token) => lower.includes(token));
}

function pidsOnPort(port: number): number[] {
  const out = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function pidsByCommand(pattern: string): number[] {
  const out = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
}

function killPids(pids: number[], signal: "SIGTERM" | "SIGKILL"): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already gone; ignore.
    }
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const collected = new Set<number>();
  const skipped: Array<{ pid: number; reason: string }> = [];

  for (const port of PORTS) {
    for (const pid of pidsOnPort(port)) {
      if (isDevProcess(pid)) {
        collected.add(pid);
      } else {
        const cmd = commandForPid(pid) ?? "<unknown>";
        skipped.push({ pid, reason: `port ${port} held by ${cmd}` });
      }
    }
  }
  for (const pattern of STALE_PROCESS_PATTERNS) {
    for (const pid of pidsByCommand(pattern)) collected.add(pid);
  }

  if (skipped.length > 0) {
    for (const entry of skipped) {
      console.log(
        `[kill-dev-ports] skipping pid ${entry.pid} (not one of ours): ${entry.reason}`,
      );
    }
  }

  if (collected.size === 0) return;

  const initial = [...collected];
  console.log(
    `[kill-dev-ports] cleaning up ${initial.length} stale dev process(es): ${initial.join(", ")}`,
  );

  killPids(initial, "SIGTERM");
  await wait(500);

  const stillAlive = initial.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  if (stillAlive.length > 0) {
    console.log(
      `[kill-dev-ports] force-killing ${stillAlive.length} unresponsive pid(s): ${stillAlive.join(", ")}`,
    );
    killPids(stillAlive, "SIGKILL");
  }
}

await main();
