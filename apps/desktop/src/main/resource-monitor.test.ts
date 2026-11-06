import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppMetrics: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}));

const {
  parseProcStat,
  parsePsTable,
  parsePsTime,
  processName,
  ResourceMonitor,
  chatTag,
} = await import("./resource-monitor.js");
type Sources = ConstructorParameters<typeof ResourceMonitor>[0];
type Row = Awaited<ReturnType<Sources["table"]>>;

const MAIN = 100;

function monitor(input: {
  table: () => NonNullable<Row>;
  chats?: Record<number, { sessionId: string; projectId: string }>;
  owners?: Sources["owners"];
  pages?: Sources["pages"];
  now: () => number;
  kill?: Sources["kill"];
}) {
  return new ResourceMonitor({
    mainPid: MAIN,
    table: async () => input.table(),
    details: async (pids) =>
      new Map(
        pids.map((pid) => [
          pid,
          {
            command: `command ${pid}`,
            ...(input.chats?.[pid] ? { chat: input.chats[pid] } : {}),
          },
        ]),
      ),
    electron: () => [
      { pid: MAIN, type: "Browser", cpu: 3, memory: 200 },
      { pid: 101, type: "GPU", cpu: 1, memory: 50 },
      { pid: 102, type: "Tab", cpu: 2, memory: 80 },
    ],
    pages: input.pages ?? (() => []),
    owners: input.owners ?? (() => new Map()),
    kill: input.kill ?? (() => {}),
    now: input.now,
    cores: 8,
    totalMemory: 16 * 1024 ** 3,
  });
}

const row = (
  pid: number,
  ppid: number,
  cpuTime: number,
  comm = "proc",
): NonNullable<Row>[number] => ({ pid, ppid, memory: 1024, cpuTime, comm });

describe("process tables", () => {
  it("reads ps times of every length", () => {
    expect(parsePsTime("0:01.50")).toBe(1.5);
    expect(parsePsTime("218:20.90")).toBeCloseTo(13_100.9);
    expect(parsePsTime("1:02:03")).toBe(3723);
    expect(parsePsTime("2-01:00:00")).toBe(2 * 86_400 + 3600);
  });

  it("reads macOS ps rows, executables with spaces included", () => {
    const rows = parsePsTable(
      "  100     1  2048   0:01.00   1.5 /Applications/Work.app/Contents/MacOS/Work\n" +
        "  200   100   512   0:00.20   0.0 /Users/me/My Tools/bin/bun\n" +
        "garbage\n",
    );
    expect(rows).toEqual([
      {
        pid: 100,
        ppid: 1,
        memory: 2048 * 1024,
        cpuTime: 1,
        cpu: 1.5,
        comm: "Work",
      },
      {
        pid: 200,
        ppid: 100,
        memory: 512 * 1024,
        cpuTime: 0.2,
        cpu: 0,
        comm: "bun",
      },
    ]);
  });

  it("reads /proc stat, a name with spaces and parentheses included", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index));
    fields[1] = "100"; // ppid
    fields[11] = "150"; // utime
    fields[12] = "50"; // stime
    fields[21] = "10"; // rss pages
    const parsed = parseProcStat(
      `4242 (my (odd) tool) S ${fields.slice(1).join(" ")}`,
      {
        ticks: 100,
        pageSize: 4096,
      },
    );
    expect(parsed).toEqual({
      pid: 4242,
      ppid: 100,
      memory: 10 * 4096,
      cpuTime: 2,
      comm: "my (odd) tool",
    });
  });

  it("finds the chat tag and its project in ps and /proc environments", () => {
    expect(
      chatTag(
        "bun run dev HOME=/x CATAMORPHIC_SESSION_ID=abc-123 CATAMORPHIC_PROJECT_ID=p-9 PATH=/y",
      ),
    ).toEqual({ sessionId: "abc-123", projectId: "p-9" });
    expect(
      chatTag("A=1\0CATAMORPHIC_PROJECT_ID=p1\0CATAMORPHIC_SESSION_ID=s1\0"),
    ).toEqual({ sessionId: "s1", projectId: "p1" });
    expect(
      chatTag("XCATAMORPHIC_SESSION_ID=nope CATAMORPHIC_PROJECT_ID=p1"),
    ).toBeUndefined();
    // A chat is named with its project, or not at all.
    expect(chatTag("CATAMORPHIC_SESSION_ID=s1")).toBeUndefined();
  });

  it("names interpreters by what they run", () => {
    expect(processName("bun", "bun run --watch dev")).toBe("bun run dev");
    expect(processName("node", "/usr/bin/node /srv/app/server.js")).toBe(
      "node server.js",
    );
    expect(processName("claude", "claude --output-format stream-json")).toBe(
      "claude",
    );
  });
});

describe("ResourceMonitor", () => {
  it("credits processes to their nearest owner and measures CPU between samples", async () => {
    let now = 0;
    let used = 0;
    const sampler = monitor({
      now: () => now,
      // The harness (tagged) runs a dev server; a terminal's shell runs a
      // build; Electron's helpers stay Work's; an untagged child is Work's.
      table: () => [
        row(MAIN, 1, 0, "Work"),
        row(101, MAIN, 0, "Work Helper (GPU)"),
        row(200, MAIN, used, "claude"),
        row(201, 200, 0, "bun"),
        row(300, MAIN, 0, "zsh"),
        row(301, 300, 0, "make"),
        row(400, MAIN, 0, "crashpad"),
      ],
      chats: {
        200: { sessionId: "s1", projectId: "p1" },
        201: { sessionId: "s1", projectId: "p1" },
      },
      owners: () =>
        new Map([[300, { kind: "terminal", terminalId: "t1", title: "zsh" }]]),
    });
    const first = await sampler.read();
    expect(first.groups.map((group) => group.id)).toEqual([
      "work",
      "chat:s1",
      "terminal:t1",
    ]);
    const work = first.groups[0];
    expect(
      work?.processes.map((proc) => [proc.pid, proc.name, proc.endable]),
    ).toEqual([
      [MAIN, "Main process", false],
      [101, "Graphics", false],
      [102, "Renderer", false],
      [400, "crashpad", true],
    ]);
    const chat = first.groups[1];
    expect(chat?.owner).toEqual({
      kind: "chat",
      sessionId: "s1",
      projectId: "p1",
    });
    expect(chat?.processes.map((proc) => [proc.pid, proc.parentPid])).toEqual([
      [200, undefined],
      [201, 200],
    ]);

    // Two seconds later the harness used one more second of CPU: 50%.
    now = 2_000;
    used = 1;
    const second = await sampler.read();
    const harness = second.groups[1]?.processes[0];
    expect(harness?.cpu).toBeCloseTo(50);
    expect(harness?.history).toEqual([0, 50]);
    expect(second.history).toHaveLength(2);
  });

  it("shares a sample between reads within a second", async () => {
    const table = vi.fn(() => [row(MAIN, 1, 0)]);
    let now = 0;
    const sampler = monitor({ now: () => now, table });
    await Promise.all([sampler.read(), sampler.read()]);
    now = 500;
    await sampler.read();
    expect(table).toHaveBeenCalledTimes(1);
    now = 1_500;
    await sampler.read();
    expect(table).toHaveBeenCalledTimes(2);
  });

  it("credits a browser tab's renderer to its page", async () => {
    const sampler = monitor({
      now: () => 0,
      table: () => [row(MAIN, 1, 0)],
      pages: () => [
        {
          id: 7,
          type: "webview",
          title: "Docs",
          url: "https://example.com",
          pids: [102],
        },
      ],
    });
    const snapshot = await sampler.read();
    const page = snapshot.groups.find((group) => group.owner.kind === "page");
    expect(page?.owner).toEqual({
      kind: "page",
      webContentsId: 7,
      title: "Docs",
      url: "https://example.com",
    });
    expect(page?.processes.map((proc) => proc.pid)).toEqual([102]);
  });

  it("ends what Work started with its descendants, never Work itself", async () => {
    vi.useFakeTimers();
    try {
      const signals: [number, NodeJS.Signals | 0][] = [];
      const alive = new Set([201]);
      const sampler = monitor({
        now: () => 0,
        table: () => [row(MAIN, 1, 0), row(200, MAIN, 0), row(201, 200, 0)],
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 0 && !alive.has(pid)) throw new Error("ESRCH");
        },
      });
      await sampler.read();
      expect(() => sampler.end(MAIN)).toThrow();
      expect(() => sampler.end(101)).toThrow();
      sampler.end(200);
      expect(signals).toEqual([
        [201, "SIGTERM"],
        [200, "SIGTERM"],
      ]);
      vi.advanceTimersByTime(3_000);
      expect(signals.slice(2)).toEqual([
        [200, 0],
        [201, 0],
        [201, "SIGKILL"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists only Electron's processes where it reads no table", async () => {
    const sampler = new ResourceMonitor({
      mainPid: MAIN,
      table: async () => null,
      details: async () => new Map(),
      electron: () => [{ pid: MAIN, type: "Browser", cpu: 1, memory: 10 }],
      pages: () => [],
      owners: () => new Map(),
      kill: () => {},
      now: () => 0,
      cores: 4,
      totalMemory: 1,
    });
    const snapshot = await sampler.read();
    expect(snapshot.children).toBe(false);
    expect(snapshot.groups.map((group) => group.id)).toEqual(["work"]);
  });
});
