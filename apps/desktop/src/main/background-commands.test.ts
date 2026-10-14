import { describe, expect, it } from "vitest";
import {
  BackgroundCommands,
  type BackgroundCommandView,
  type BackgroundNotifier,
} from "./background-commands.js";

/** A scriptable terminal: tests append output and end commands. */
function fakeTerminals() {
  const state = new Map<
    string,
    {
      buffer: string;
      running: boolean;
      completions: number;
      exit: number | null;
      shellExit?: number;
      /** How long the shell takes to show an interrupt ended its command. */
      interruptMs?: number;
      busyUntil?: number;
      /** A shell without markers: only its foreground process tells busy. */
      unmarked?: { busy: boolean };
    }
  >();
  let next = 0;
  const written: Array<{ id: string; data: string }> = [];
  const killed: string[] = [];
  return {
    written,
    killed,
    /** ^C ends the command at once, but the shell takes a while to show it. */
    slowInterrupt(id: string, ms: number) {
      const terminal = state.get(id);
      if (terminal) terminal.interruptMs = ms;
    },
    print(id: string, text: string) {
      const terminal = state.get(id);
      if (terminal) terminal.buffer += text;
    },
    finish(id: string, exit: number) {
      const terminal = state.get(id);
      if (!terminal) return;
      terminal.completions += 1;
      terminal.exit = exit;
    },
    close(id: string) {
      const terminal = state.get(id);
      if (terminal) terminal.running = false;
    },
    /** A shell without OSC 133 markers, its foreground process busy or not. */
    unmarked(id: string, busy: boolean) {
      const terminal = state.get(id);
      if (terminal) terminal.unmarked = { busy };
    },
    /** The command ran `exit`: the shell ends by itself with this code. */
    exitShell(id: string, code: number) {
      const terminal = state.get(id);
      if (!terminal) return;
      terminal.running = false;
      terminal.shellExit = code;
    },
    terminals: {
      async create() {
        const id = `t${++next}`;
        state.set(id, {
          buffer: "$ ",
          running: true,
          completions: 0,
          exit: null,
        });
        return { sessionId: id, cwd: "/project" };
      },
      writeAny(id: string, data: string) {
        written.push({ id, data });
        if (data === "\u0003") {
          const terminal = state.get(id);
          if (terminal) {
            terminal.completions += 1;
            terminal.exit = 130;
            terminal.busyUntil = Date.now() + (terminal.interruptMs ?? 0);
          }
        }
        return true;
      },
      isRunning: (id: string) => state.get(id)?.running ?? false,
      exitCode: (id: string) => state.get(id)?.shellExit,
      isBusy: (id: string) => {
        const terminal = state.get(id);
        if (terminal?.unmarked) return terminal.unmarked.busy;
        return Boolean(
          terminal?.running &&
            (terminal.completions === 0 ||
              Date.now() < (terminal.busyUntil ?? 0)),
        );
      },
      commandTracking: (id: string) => {
        const terminal = state.get(id);
        return terminal
          ? {
              seen: !terminal.unmarked,
              completions: terminal.completions,
              prompts: terminal.completions + 1,
              lastExitCode: terminal.exit,
            }
          : null;
      },
      bufferLength: (id: string) => state.get(id)?.buffer.length ?? null,
      readFrom: (id: string, offset: number) =>
        state.get(id)?.buffer.slice(offset) ?? "",
      // Like the real one: a killed terminal is gone, buffer and all.
      kill: (id: string) => {
        killed.push(id);
        return state.delete(id);
      },
    },
  };
}

function setup() {
  const fake = fakeTerminals();
  const snapshots: BackgroundCommandView[][] = [];
  const wakes: Parameters<BackgroundNotifier>[0][] = [];
  const commands = new BackgroundCommands({
    terminals: fake.terminals,
    attach: async ({ terminalId }) => `terminal:${terminalId}`,
    waitReady: async () => {},
    modelOutput: (raw) => raw,
    encode: (command) => `${command}\r`,
    changed: (list) => snapshots.push(list),
    pollMs: 20,
    outputWakeMs: 50,
  });
  commands.setNotifier(async (input) => {
    wakes.push(input);
  });
  return { fake, commands, snapshots, wakes };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("BackgroundCommands", () => {
  it("never ends a command on a shell without markers for one idle moment", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "sleep 5; for i in 1 2; do sleep 1; done",
      description: "Loop",
    });
    await until(() => fake.written.length > 0);
    fake.unmarked("t1", true);
    expect(await started).toMatchObject({ status: "running" });
    // The shell forks the next `sleep`: idle for a moment, then busy.
    fake.unmarked("t1", false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    fake.unmarked("t1", true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(commands.list({ sessionId: "chat" })[0]?.status).toBe("running");
    expect(fake.killed).toEqual([]);
    // Back at the prompt for good: its end, once the idle lasts.
    fake.unmarked("t1", false);
    await until(() => wakes.length > 0);
    expect(commands.list({ sessionId: "chat" })[0]?.status).toBe("finished");
    expect(fake.killed).toEqual(["t1"]);
    commands.dispose();
  }, 10_000);

  it("keeps running past the call and wakes the chat when it finishes", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "bun run build",
      description: "Build the app",
    });
    await until(() => fake.written.length > 0);
    fake.print("t1", "compiling…\n");
    const result = await started;
    expect(result).toMatchObject({ id: "t1", status: "running" });
    expect(result.output).toContain("compiling");
    expect(fake.written[0]).toEqual({ id: "t1", data: "bun run build\r" });

    fake.print("t1", "error: missing module\n");
    fake.finish("t1", 1);
    await until(() => wakes.length > 0);
    // A task notification (ADR 0217): one line for the person, and the
    // output for the agent. Its terminal ended with it (ADR 0223), so
    // there is no terminal to open.
    expect(wakes[0]).toMatchObject({
      sessionId: "chat",
      task: {
        type: "background_command",
        id: "t1",
        title: "Build the app",
        status: "failed",
      },
      summary: "Build the app failed (exit 1)",
      surfaceKey: null,
    });
    expect(wakes[0]?.detail).toContain("Command: bun run build");
    expect(wakes[0]?.detail).toContain("error: missing module");
    expect(commands.list({ sessionId: "chat" })[0]).toMatchObject({
      status: "finished",
      exitCode: 1,
    });
    expect(fake.killed).toEqual(["t1"]);
    // The agent still reads what it had not read yet, once.
    expect(await commands.read({ sessionId: "chat", id: "t1" })).toEqual({
      status: "finished",
      exitCode: 1,
      output: "error: missing module\n",
    });
    expect((await commands.read({ sessionId: "chat", id: "t1" })).output).toBe(
      "",
    );
    // Ending its terminal is not the person closing it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wakes).toHaveLength(1);
    commands.dispose();
  }, 10_000);

  it("ends a command's terminal when it finishes while the agent waits on it", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "sleep 2 && echo done",
      description: "Wait",
      wakeOnExit: false,
    });
    await until(() => fake.written.length > 0);
    await started;
    setTimeout(() => {
      fake.print("t1", "done\n");
      fake.finish("t1", 0);
    }, 100);
    expect(
      await commands.read({ sessionId: "chat", id: "t1", waitMs: 5_000 }),
    ).toEqual({ status: "finished", exitCode: 0, output: "done\n" });
    expect(fake.killed).toEqual(["t1"]);
    expect(wakes).toEqual([]);
    commands.dispose();
  });

  it("reads only new output and wakes on watched lines", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "bun run dev",
      description: "Start the dev server",
      wakeOnOutput: "ready on port \\d+",
    });
    await until(() => fake.written.length > 0);
    await started;

    fake.print("t1", "listening…\n");
    expect((await commands.read({ sessionId: "chat", id: "t1" })).output).toBe(
      "listening…\n",
    );
    expect((await commands.read({ sessionId: "chat", id: "t1" })).output).toBe(
      "",
    );

    fake.print("t1", "ready on port 3000\n");
    await until(() => wakes.length > 0);
    expect(wakes[0]?.task.status).toBe("update");
    expect(wakes[0]?.detail).toContain("ready on port 3000");
    expect(wakes[0]?.detail).toContain("still running");

    expect(
      (await commands.read({ sessionId: "chat", id: "t1" })).output,
    ).toContain("ready on port 3000");
    // A blocking read returns as soon as something new arrives.
    setTimeout(() => fake.print("t1", "GET / 200\n"), 100);
    const waited = await commands.read({
      sessionId: "chat",
      id: "t1",
      waitMs: 5_000,
    });
    expect(waited.output).toContain("GET / 200");

    // Other chats cannot reach it.
    await expect(
      commands.read({ sessionId: "other", id: "t1" }),
    ).rejects.toThrow("No background command");
    commands.dispose();
  }, 10_000);

  it("a command that exits its own shell finished", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "until test -f out; do sleep 1; done; echo FOUND; exit 0",
      description: "Wait for out",
      wakeOnOutput: "FOUND",
    });
    await until(() => fake.written.length > 0);
    await started;
    fake.print("t1", "FOUND\n");
    await until(() => wakes.length > 0);
    fake.exitShell("t1", 0);
    await until(() => wakes.length > 1);
    expect(wakes.map((wake) => [wake.summary, wake.task.status])).toEqual([
      ["Wait for out printed what you were waiting for", "update"],
      ["Wait for out finished", "completed"],
    ]);
    expect(commands.list()[0]).toMatchObject({
      status: "finished",
      exitCode: 0,
    });
    // Its shell is gone from the app too.
    expect(fake.killed).toEqual(["t1"]);
    commands.dispose();
  }, 10_000);

  it("stops without waking, and reports a closed terminal", async () => {
    const { fake, commands, wakes } = setup();
    const first = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "tail -f log",
      description: "Follow the log",
    });
    await until(() => fake.written.length > 0);
    await first;
    fake.print("t1", "line 1\n");
    expect(await commands.stop({ sessionId: "chat", id: "t1" })).toEqual({
      status: "stopped",
      output: "line 1\n",
    });
    expect(fake.written.at(-1)?.data).toBe("\u0003");
    expect(fake.killed).toEqual(["t1"]);
    expect(await commands.read({ sessionId: "chat", id: "t1" })).toMatchObject({
      status: "stopped",
      output: "",
    });

    const second = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "sleep 100",
      description: "Wait",
    });
    await until(() => fake.written.length > 2);
    await second;
    fake.close("t2");
    await until(() => wakes.length > 0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      summary: "Wait was stopped",
      task: { status: "stopped" },
    });
    commands.dispose();
  }, 15_000);

  it("a stop is a stop, however the interrupted command ends meanwhile", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "bun run dev",
      description: "Start the dev server",
    });
    await until(() => fake.written.length > 0);
    await started;
    fake.slowInterrupt("t1", 300);
    expect(await commands.stop({ sessionId: "chat", id: "t1" })).toMatchObject({
      status: "stopped",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(commands.list()[0]).toMatchObject({
      status: "stopped",
      exitCode: null,
    });
    expect(fake.killed).toEqual(["t1"]);
    expect(wakes).toEqual([]);
    commands.dispose();
  });

  it("wakes about a matching line once, however often it prints again", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "bun run worker",
      description: "Start the worker",
      wakeOnOutput: "Error|ready",
    });
    await until(() => fake.written.length > 0);
    await started;
    fake.print("t1", 'reason: "Error: Debugger.enable is not supported"\n');
    await until(() => wakes.length > 0);
    for (let round = 0; round < 3; round++) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      fake.print("t1", 'reason: "Error: Debugger.enable is not supported"\n');
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wakes).toHaveLength(1);
    // Something new still wakes it.
    fake.print("t1", "worker ready\n");
    await until(() => wakes.length > 1);
    expect(wakes[1]?.detail).toContain("worker ready");
    expect(wakes[1]?.detail).not.toContain("Debugger.enable");
    commands.dispose();
  }, 10_000);

  it("matches whole lines only, however the output arrives", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "bun run dev",
      description: "Start the dev server",
      wakeOnOutput: "ready on port \\d+$",
    });
    await until(() => fake.written.length > 0);
    await started;
    fake.print("t1", "ready on po");
    await new Promise((resolve) => setTimeout(resolve, 120));
    fake.print("t1", "rt 3000\n");
    await until(() => wakes.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.detail).toContain("ready on port 3000");
    commands.dispose();
  }, 10_000);

  it("never wakes about output the agent is already reading", async () => {
    const { fake, commands, wakes } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "tick",
      description: "Tick",
      wakeOnOutput: "tick",
    });
    await until(() => fake.written.length > 0);
    await started;
    setTimeout(() => fake.print("t1", "tick 1\n"), 100);
    const read = await commands.read({
      sessionId: "chat",
      id: "t1",
      waitMs: 5_000,
    });
    expect(read.output).toContain("tick 1");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(wakes).toEqual([]);
    commands.dispose();
  });

  it("waits for a matching line across several prints", async () => {
    const { fake, commands } = setup();
    const started = commands.start({
      projectId: "p",
      sessionId: "chat",
      command: "bun run dev",
      description: "Start the dev server",
      wakeOnExit: false,
    });
    await until(() => fake.written.length > 0);
    await started;
    setTimeout(() => fake.print("t1", "compiling…\n"), 50);
    setTimeout(() => fake.print("t1", "ready on port 3000\n"), 400);
    const waited = await commands.read({
      sessionId: "chat",
      id: "t1",
      waitMs: 5_000,
      waitFor: "ready on port \\d+",
    });
    expect(waited).toMatchObject({
      status: "running",
      matched: "ready on port 3000",
    });
    expect(waited.output).toContain("compiling…");
    await expect(
      commands.read({ sessionId: "chat", id: "t1", waitFor: "(" }),
    ).rejects.toThrow("wait_for is not a valid regular expression");
    commands.dispose();
  });

  it("rejects an invalid output pattern before starting anything", async () => {
    const { fake, commands } = setup();
    await expect(
      commands.start({
        projectId: "p",
        sessionId: "chat",
        command: "bun run dev",
        description: "Dev",
        wakeOnOutput: "(",
      }),
    ).rejects.toThrow("not a valid regular expression");
    expect(fake.written).toEqual([]);
  });
});
