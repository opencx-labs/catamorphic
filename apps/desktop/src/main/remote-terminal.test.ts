import { describe, expect, it, vi } from "vitest";
import {
  openRemoteTerminal,
  RemoteTerminalError,
  type RemoteTerminalRequest,
} from "./remote-terminal.js";

type Call = Parameters<RemoteTerminalRequest>[0];

/**
 * A project's server holding one terminal: output is handed out as the
 * test pushes it, and every request is recorded.
 */
function fakeServer(options: { pty?: boolean; open?: number } = {}) {
  const calls: Call[] = [];
  const chunks: string[] = [];
  let exited: number | null = null;
  let gone = false;
  let wake: (() => void) | undefined;
  const request: RemoteTerminalRequest = async (call) => {
    calls.push(call);
    if (call.method === "POST" && call.path === "")
      return options.open && options.open !== 201
        ? {
            status: options.open,
            body: {
              error:
                "This chat's workspace is not running; send it a message to start it.",
              code: "not_running",
            },
          }
        : {
            status: 201,
            body: { terminalId: "proc-0123456789", pty: options.pty ?? true },
          };
    if (call.method === "GET") {
      const cursor = Number(
        new URLSearchParams(call.path.split("?")[1]).get("cursor"),
      );
      const text = () => chunks.join("");
      if (text().length <= cursor && exited === null && !gone)
        await new Promise<void>((resolve) => {
          wake = resolve;
          call.signal?.addEventListener("abort", () => resolve());
        });
      if (gone)
        return {
          status: 404,
          body: { error: "This terminal ended with its chat's workspace." },
        };
      const all = text();
      return {
        status: 200,
        body: {
          data: all.slice(cursor),
          cursor,
          nextCursor: all.length,
          more: false,
          exited: exited !== null,
          exitCode: exited,
        },
      };
    }
    return { status: 200, body: { ok: true } };
  };
  return {
    request,
    calls,
    print(text: string) {
      chunks.push(text);
      wake?.();
    },
    exit(code: number) {
      exited = code;
      wake?.();
    },
    end() {
      gone = true;
      wake?.();
    },
  };
}

const inputs = (calls: Call[]) =>
  calls.flatMap((call) =>
    call.path.endsWith("/input") &&
    typeof call.body === "object" &&
    call.body !== null &&
    "data" in call.body &&
    typeof call.body.data === "string"
      ? [call.body.data]
      : [],
  );

describe("a terminal in a remote chat's workspace (ADR 0209)", () => {
  it("streams output from the cursor and exits with the shell", async () => {
    const server = fakeServer();
    const terminal = await openRemoteTerminal({
      request: server.request,
      cols: 100,
      rows: 30,
    });
    expect(server.calls[0]).toMatchObject({
      method: "POST",
      path: "",
      body: { cols: 100, rows: 30 },
    });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));
    const exits: Array<{ exitCode: number; message?: string }> = [];
    terminal.onExit((event) => exits.push(event));
    server.print("$ ");
    server.print("hello\r\n");
    await vi.waitFor(() => expect(output.join("")).toBe("$ hello\r\n"));
    server.exit(3);
    await vi.waitFor(() => expect(exits).toEqual([{ exitCode: 3 }]));
    const reads = server.calls.filter((call) => call.method === "GET");
    expect(reads.at(-1)?.path).toMatch(/cursor=9&waitMs=15000$/);
  });

  it("sends keystrokes in order, batching what is typed while one travels", async () => {
    const server = fakeServer();
    const terminal = await openRemoteTerminal({
      request: server.request,
      cols: 80,
      rows: 24,
    });
    terminal.write("l");
    terminal.write("s");
    await vi.waitFor(() => expect(inputs(server.calls)).toEqual(["ls"]));
    terminal.write("\r");
    terminal.write("\u0003");
    await vi.waitFor(() =>
      expect(inputs(server.calls).join("")).toBe("ls\r\u0003"),
    );
    terminal.kill();
  });

  it("sends only the latest size, and none without a pseudo-terminal", async () => {
    const server = fakeServer();
    const terminal = await openRemoteTerminal({
      request: server.request,
      cols: 80,
      rows: 24,
    });
    terminal.resize(80, 24);
    terminal.resize(90, 30);
    terminal.resize(120, 40);
    await vi.waitFor(() =>
      expect(
        server.calls
          .filter((call) => call.path.endsWith("/resize"))
          .map((call) => call.body)
          .at(-1),
      ).toEqual({ cols: 120, rows: 40 }),
    );
    expect(
      server.calls.filter((call) => call.path.endsWith("/resize")).length,
    ).toBeLessThanOrEqual(2);
    terminal.kill();

    const plain = fakeServer({ pty: false });
    const pipe = await openRemoteTerminal({
      request: plain.request,
      cols: 80,
      rows: 24,
    });
    const notice: string[] = [];
    pipe.onData((data) => notice.push(data));
    expect(notice.join("")).toContain("no pseudo-terminal");
    pipe.resize(100, 40);
    expect(plain.calls.some((call) => call.path.endsWith("/resize"))).toBe(
      false,
    );
    pipe.kill();
  });

  it("closes the remote shell when the tab kills it", async () => {
    const server = fakeServer();
    const terminal = await openRemoteTerminal({
      request: server.request,
      cols: 80,
      rows: 24,
    });
    const exits: Array<{ exitCode: number }> = [];
    terminal.onExit((event) => exits.push(event));
    terminal.kill();
    expect(exits).toEqual([{ exitCode: 0 }]);
    await vi.waitFor(() =>
      expect(server.calls).toContainEqual({
        method: "DELETE",
        path: "/proc-0123456789",
      }),
    );
    // Typing after the end goes nowhere.
    terminal.write("ignored");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputs(server.calls)).toEqual([]);
  });

  it("says why when the workspace ended, instead of closing", async () => {
    const server = fakeServer();
    const terminal = await openRemoteTerminal({
      request: server.request,
      cols: 80,
      rows: 24,
    });
    const exits: Array<{ exitCode: number; message?: string }> = [];
    terminal.onExit((event) => exits.push(event));
    server.end();
    await vi.waitFor(() =>
      expect(exits).toEqual([
        {
          exitCode: 1,
          message: "This terminal ended with its chat's workspace.",
        },
      ]),
    );
  });

  it("refuses to open with the server's reason", async () => {
    const server = fakeServer({ open: 409 });
    await expect(
      openRemoteTerminal({ request: server.request, cols: 80, rows: 24 }),
    ).rejects.toEqual(
      new RemoteTerminalError(
        409,
        "This chat's workspace is not running; send it a message to start it.",
      ),
    );
  });
});
