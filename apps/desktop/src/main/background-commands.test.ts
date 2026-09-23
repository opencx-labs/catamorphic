import { describe, expect, it } from "vitest";
import {
  BackgroundCommands,
  type BackgroundCommandView,
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
    }
  >();
  let next = 0;
  const written: Array<{ id: string; data: string }> = [];
  return {
    written,
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
          if (terminal) terminal.completions += 1;
        }
        return true;
      },
      isRunning: (id: string) => state.get(id)?.running ?? false,
      isBusy: (id: string) => {
        const terminal = state.get(id);
        return Boolean(terminal?.running && terminal.completions === 0);
      },
      commandTracking: (id: string) => {
        const terminal = state.get(id);
        return terminal
          ? {
              seen: true,
              completions: terminal.completions,
              prompts: terminal.completions + 1,
              lastExitCode: terminal.exit,
            }
          : null;
      },
      bufferLength: (id: string) => state.get(id)?.buffer.length ?? null,
      readFrom: (id: string, offset: number) =>
        state.get(id)?.buffer.slice(offset) ?? "",
      kill: (id: string) => {
        const terminal = state.get(id);
        if (terminal) terminal.running = false;
        return true;
      },
    },
  };
}

function setup() {
  const fake = fakeTerminals();
  const snapshots: BackgroundCommandView[][] = [];
  const wakes: Array<{ sessionId: string; notice: string; content: string }> =
    [];
  const commands = new BackgroundCommands({
    terminals: fake.terminals,
    attach: async ({ terminalId }) => `terminal:${terminalId}`,
    waitReady: async () => {},
    modelOutput: (raw) => raw,
    encode: (command) => `${command}\r`,
    changed: (list) => snapshots.push(list),
    pollMs: 20,
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
    expect(wakes[0]).toMatchObject({
      sessionId: "chat",
      notice: "Build the app failed (exit 1)",
    });
    expect(wakes[0]?.content).toContain("failed with exit code 1");
    expect(wakes[0]?.content).toContain("error: missing module");
    expect(commands.list({ sessionId: "chat" })[0]).toMatchObject({
      status: "finished",
      exitCode: 1,
    });
    commands.dispose();
  }, 10_000);

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
    expect(wakes[0]?.content).toContain("ready on port 3000");
    expect(wakes[0]?.content).toContain("still running");

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
    expect(await commands.stop({ sessionId: "chat", id: "t1" })).toMatchObject({
      status: "stopped",
    });
    expect(fake.written.at(-1)?.data).toBe("\u0003");
    expect(fake.terminals.isRunning("t1")).toBe(false);

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
    expect(wakes[0]?.notice).toBe("Wait was stopped");
    commands.dispose();
  }, 15_000);

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
