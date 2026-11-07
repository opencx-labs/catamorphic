import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundLaunchArguments,
  backgroundRuntimeAllowed,
  callBackgroundRuntime,
  handOffBackgroundRuntime,
  serveBackgroundRuntime,
} from "./background-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-background-test-"));
  roots.push(root);
  return root;
}

describe("Work background engine", () => {
  it("flushes storage before releasing ownership or starting the helper", async () => {
    const calls: string[] = [];
    await handOffBackgroundRuntime({
      enabled: true,
      allowed: true,
      shutdown: async () => {
        calls.push("flush");
      },
      releaseLock: () => {
        calls.push("release");
      },
      launch: async () => {
        calls.push("start");
      },
    });
    expect(calls).toEqual(["flush", "release", "start"]);
  });

  it("does not transfer ownership after any shutdown or flush failure", async () => {
    const releaseLock = vi.fn();
    const launch = vi.fn();
    await expect(
      handOffBackgroundRuntime({
        enabled: true,
        allowed: true,
        shutdown: async () => {
          throw new Error("WAL flush failed");
        },
        releaseLock,
        launch,
      }),
    ).rejects.toThrow("WAL flush failed");
    expect(releaseLock).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, allowed: true },
    { enabled: true, allowed: false },
  ])(
    "does not start without approved work and host lifetime permission (%j)",
    async (options) => {
      const launch = vi.fn();
      await handOffBackgroundRuntime({
        ...options,
        shutdown: async () => {},
        releaseLock: vi.fn(),
        launch,
      });
      expect(launch).not.toHaveBeenCalled();
      expect(
        backgroundRuntimeAllowed({ CATAMORPHIC_E2E_DATA_DIR: "/tmp/test" }),
      ).toBe(false);
      expect(
        backgroundRuntimeAllowed({
          CATAMORPHIC_E2E_DATA_DIR: "/tmp/test",
          CATAMORPHIC_E2E_BACKGROUND_RUNTIME: "1",
        }),
      ).toBe(true);
    },
  );

  it("strips debugger endpoints from a helper's launch", () => {
    expect(
      backgroundLaunchArguments([
        "/app",
        "--remote-debugging-port=9333",
        "--inspect=9334",
        "work://connect?project=test",
        "--background-runtime",
      ]),
    ).toEqual(["/app", "work://connect?project=test", "--background-runtime"]);
  });

  it("admits only authenticated local host inspection and removes its record on close", async () => {
    const root = directory();
    const shutdown = vi.fn();
    const control = await serveBackgroundRuntime({
      userData: root,
      inspect: async () => ({ running: true }),
      shutdown,
    });
    try {
      expect(
        await callBackgroundRuntime({ userData: root, command: "inspect" }),
      ).toEqual({ running: true });
      const record = JSON.parse(
        fs.readFileSync(path.join(root, "background-runtime.json"), "utf8"),
      );
      expect(
        fs.statSync(path.join(root, "background-runtime.json")).mode & 0o777,
      ).toBe(0o600);
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(record.port, "127.0.0.1", () =>
          socket.write(
            `${JSON.stringify({ token: "wrong", command: "shutdown" })}\n`,
          ),
        );
        socket.once("error", reject);
        socket.once("close", () => resolve());
      });
      expect(shutdown).not.toHaveBeenCalled();
      expect(
        await callBackgroundRuntime({ userData: root, command: "shutdown" }),
      ).toEqual({ stopping: true });
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    } finally {
      await control.close();
    }
    expect(fs.existsSync(path.join(root, "background-runtime.json"))).toBe(
      false,
    );
  });

  it("continues real work in a new OS process after the original process exited", async () => {
    const root = directory();
    const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
    if (!bun) throw new Error("This repository requires Bun.");
    const child = spawn(
      bun,
      [
        path.join(import.meta.dirname, "__fixtures__/background-handoff.ts"),
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let helperPid: number | undefined;
    try {
      expect(await exited, output).toBe(0);
      const originalPid = Number(
        fs.readFileSync(path.join(root, "foreground.pid"), "utf8"),
      );
      expect(() => process.kill(originalPid, 0)).toThrow();
      const initial = zInspect(
        await callBackgroundRuntime({ userData: root, command: "inspect" }),
      );
      helperPid = initial.pid;
      expect(helperPid).not.toBe(originalPid);
      expect(initial.windows).toBe(0);
      await vi.waitFor(async () => {
        const current = zInspect(
          await callBackgroundRuntime({ userData: root, command: "inspect" }),
        );
        expect(current.ticks).toBeGreaterThan(initial.ticks);
      });
    } finally {
      if (fs.existsSync(path.join(root, "background-runtime.json")))
        await callBackgroundRuntime({ userData: root, command: "shutdown" });
      if (helperPid) {
        const pid = helperPid;
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      }
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    expect(fs.existsSync(path.join(root, "engine.lock"))).toBe(false);
  });
});

function zInspect(raw: unknown): {
  pid: number;
  ticks: number;
  windows: number;
} {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("pid" in raw) ||
    typeof raw.pid !== "number" ||
    !("ticks" in raw) ||
    typeof raw.ticks !== "number" ||
    !("windows" in raw) ||
    typeof raw.windows !== "number"
  )
    throw new Error("Invalid fixture inspection");
  return { pid: raw.pid, ticks: raw.ticks, windows: raw.windows };
}
