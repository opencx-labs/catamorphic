import { describe, expect, it } from "vitest";
import {
  commandSideProcesses,
  newProcessId,
  type SandboxProcess,
  type SandboxProcessProvider,
  type StartProcessArgs,
} from "../processes.js";

/**
 * What a model or a person reaches of a sandbox whose commands run apart
 * (ADR 0332): the command side's processes, never the runner beside the
 * agent.
 */
describe("commandSideProcesses", () => {
  const runner = newProcessId({ side: "agent" });
  const server = newProcessId();
  const process = (processId: string, name: string): SandboxProcess => ({
    processId,
    sandboxId: "sandbox",
    command: name,
    name,
    cwd: "/workspace/project",
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: "2026-11-18T00:00:00.000Z",
    endedAt: null,
    outputBytes: 0,
  });
  const started: StartProcessArgs[] = [];
  const touched: string[] = [];
  const all: SandboxProcessProvider = {
    startProcess: async (args) => {
      started.push(args);
      return process(server, args.name ?? "");
    },
    readProcessOutput: async (args) => {
      touched.push(args.processId);
      return {
        processId: args.processId,
        chunk: "",
        cursor: 0,
        nextCursor: 0,
        more: false,
        outputBytes: 0,
        status: "running",
        exitCode: null,
        signal: null,
      };
    },
    signalProcess: async (args) => {
      touched.push(args.processId);
      return process(args.processId, "signalled");
    },
    writeProcessInput: async (args) => {
      touched.push(args.processId);
    },
    listProcesses: async () => [
      process(runner, "Agent runner"),
      process(server, "Dev server"),
    ],
  };
  const reachable = commandSideProcesses(all);

  it("lists and reaches the command side's processes only", async () => {
    expect(
      (await reachable.listProcesses({ sandboxId: "sandbox" })).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Dev server"]);
    for (const reach of [
      () =>
        reachable.readProcessOutput({
          sandboxId: "sandbox",
          processId: runner,
        }),
      () =>
        reachable.signalProcess({
          sandboxId: "sandbox",
          processId: runner,
          signal: "SIGKILL",
        }),
      () =>
        reachable.writeProcessInput({
          sandboxId: "sandbox",
          processId: runner,
          data: "{}\n",
        }),
    ])
      await expect(reach()).rejects.toThrow("Unknown process");
    expect(touched).toEqual([]);
    await reachable.readProcessOutput({
      sandboxId: "sandbox",
      processId: server,
    });
    expect(touched).toEqual([server]);
  });

  it("starts what it starts where commands run", async () => {
    await reachable.startProcess({
      sandboxId: "sandbox",
      side: "agent",
      command: "sleep 1",
      name: "Sneaky",
    });
    expect(started.at(-1)?.side).toBeUndefined();
  });
});
