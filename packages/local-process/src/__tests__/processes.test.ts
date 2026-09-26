import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { followProcess } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandboxProvider } from "../sandbox-provider.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("LocalProcessSandboxProvider background processes (ADR 0174)", () => {
  let root: string;
  let provider: LocalProcessSandboxProvider;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-lp-procs-"));
    provider = new LocalProcessSandboxProvider({ root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts in the workspace, reads by cursor, and reports the exit code", async () => {
    const sandbox = await provider.createSandbox({
      envVars: { SANDBOX_VALUE: "from-sandbox" },
    });
    const started = await provider.processes.startProcess({
      sandboxId: sandbox.id,
      command:
        'echo "$SANDBOX_VALUE $CALL_VALUE $(pwd)"; sleep 0.3; echo done; exit 7',
      cwd: "/workspace/app",
      env: { CALL_VALUE: "from-call" },
      name: "Build",
    });
    expect(started).toMatchObject({
      status: "running",
      cwd: "/workspace/app",
      name: "Build",
    });
    const first = await provider.processes.readProcessOutput({
      sandboxId: sandbox.id,
      processId: started.processId,
      waitMs: 5_000,
    });
    expect(first.chunk).toBe(
      `from-sandbox from-call ${fs.realpathSync(path.join(root, sandbox.id, "workspace", "app"))}\n`,
    );
    const rest = await followProcess({
      processes: provider.processes,
      sandboxId: sandbox.id,
      processId: started.processId,
      cursor: first.nextCursor,
      timeoutMs: 10_000,
    });
    expect(rest).toMatchObject({
      output: "done\n",
      status: "exited",
      exitCode: 7,
    });
    // Rereading from the start returns everything; past the end, nothing.
    const again = await provider.processes.readProcessOutput({
      sandboxId: sandbox.id,
      processId: started.processId,
    });
    expect(again.chunk.endsWith("done\n")).toBe(true);
    const beyond = await provider.processes.readProcessOutput({
      sandboxId: sandbox.id,
      processId: started.processId,
      cursor: 1_000_000,
    });
    expect(beyond).toMatchObject({ chunk: "", nextCursor: again.nextCursor });
    const [listed] = await provider.processes.listProcesses({
      sandboxId: sandbox.id,
    });
    expect(listed).toMatchObject({
      processId: started.processId,
      status: "exited",
      exitCode: 7,
      outputBytes: again.nextCursor,
    });
    await provider.destroySandbox(sandbox.id);
  }, 20_000);

  it("waits for a line, signals the process group, and keeps sandboxes apart", async () => {
    const sandbox = await provider.createSandbox({});
    const other = await provider.createSandbox({});
    const started = await provider.processes.startProcess({
      sandboxId: sandbox.id,
      command:
        'sleep 300 & echo "child $!"; sleep 0.2; echo "listening on 3000"; wait',
    });
    const ready = await followProcess({
      processes: provider.processes,
      sandboxId: sandbox.id,
      processId: started.processId,
      cursor: 0,
      until: /listening on/,
      timeoutMs: 10_000,
    });
    expect(ready).toMatchObject({
      matched: "listening on 3000",
      status: "running",
    });
    const grandchild = Number(ready.output.match(/child (\d+)/)?.[1]);
    expect(alive(grandchild)).toBe(true);
    await expect(
      provider.processes.readProcessOutput({
        sandboxId: other.id,
        processId: started.processId,
      }),
    ).rejects.toThrow("Unknown process");
    const signalled = await provider.processes.signalProcess({
      sandboxId: sandbox.id,
      processId: started.processId,
      signal: "SIGINT",
    });
    expect(signalled.signal).toBe("SIGINT");
    const ended = await followProcess({
      processes: provider.processes,
      sandboxId: sandbox.id,
      processId: started.processId,
      cursor: ready.cursor,
      timeoutMs: 10_000,
    });
    expect(ended).toMatchObject({ status: "exited", signal: "SIGINT" });
    await expect.poll(() => alive(grandchild)).toBe(false);
    await provider.destroySandbox(sandbox.id);
    await provider.destroySandbox(other.id);
  }, 20_000);

  it("dies with its sandbox", async () => {
    const sandbox = await provider.createSandbox({});
    const started = await provider.processes.startProcess({
      sandboxId: sandbox.id,
      command: 'sleep 300 & echo "child $!"; exec sleep 300',
    });
    const first = await followProcess({
      processes: provider.processes,
      sandboxId: sandbox.id,
      processId: started.processId,
      cursor: 0,
      until: /child \d+/,
      timeoutMs: 10_000,
    });
    const grandchild = Number(first.output.match(/child (\d+)/)?.[1]);
    expect(alive(grandchild)).toBe(true);
    await provider.destroySandbox(sandbox.id);
    await expect.poll(() => alive(grandchild)).toBe(false);
    expect(fs.existsSync(path.join(root, sandbox.id))).toBe(false);
    await expect(
      provider.processes.listProcesses({ sandboxId: sandbox.id }),
    ).resolves.toEqual([]);
    await expect(
      provider.processes.startProcess({
        sandboxId: sandbox.id,
        command: "true",
      }),
    ).rejects.toThrow("not found");
  }, 20_000);

  it("a timed-out follow leaves the process running", async () => {
    const sandbox = await provider.createSandbox({});
    const started = await provider.processes.startProcess({
      sandboxId: sandbox.id,
      command: "sleep 30",
    });
    const followed = await followProcess({
      processes: provider.processes,
      sandboxId: sandbox.id,
      processId: started.processId,
      cursor: 0,
      timeoutMs: 200,
    });
    expect(followed).toMatchObject({ timedOut: true, status: "running" });
    await provider.stopSandbox(sandbox.id);
    const [stopped] = await provider.processes.listProcesses({
      sandboxId: sandbox.id,
    });
    expect(stopped).toMatchObject({ status: "exited", signal: "SIGKILL" });
    await provider.destroySandbox(sandbox.id);
  }, 20_000);
});
