import {
  AccessDeniedError,
  type PreviewRequest,
  SessionPreviewError,
  SessionTerminalNotFoundError,
  SessionWorkspaceUnavailableError,
} from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import { rewritePreviewLocation } from "../routes/session-previews.js";
import { createTestApp, TEST_IDENTITY } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const SESSION_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const TERMINAL_ID = "proc-0123456789abcdef";
const SESSION = `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`;

function terminalsApp(terminals: Record<string, unknown>) {
  return createTestApp({ core: { sessionTerminals: terminals } as never });
}

describe("terminal routes (ADR 0208)", () => {
  it("opens a terminal for the caller, sized as asked", async () => {
    const open = vi.fn(async () => ({ terminalId: TERMINAL_ID, pty: true }));
    const app = terminalsApp({ open });
    const res = await app.inject({
      method: "POST",
      url: `${SESSION}/terminals`,
      payload: { cols: 120, rows: 40 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ terminalId: TERMINAL_ID, pty: true });
    expect(open).toHaveBeenCalledWith({
      identity: expect.objectContaining(TEST_IDENTITY),
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      cols: 120,
      rows: 40,
    });
    await app.close();
  });

  it("reads output by cursor with a wait", async () => {
    const read = vi.fn(async () => ({
      data: "hello\r\n",
      cursor: 10,
      nextCursor: 17,
      more: false,
      exited: false,
      exitCode: null,
    }));
    const app = terminalsApp({ read });
    const res = await app.inject({
      method: "GET",
      url: `${SESSION}/terminals/${TERMINAL_ID}/output?cursor=10&waitMs=15000`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: "hello\r\n", nextCursor: 17 });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: TERMINAL_ID,
        cursor: 10,
        waitMs: 15000,
      }),
    );
    const tooLong = await app.inject({
      method: "GET",
      url: `${SESSION}/terminals/${TERMINAL_ID}/output?waitMs=60000`,
    });
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it("types, resizes and closes", async () => {
    const write = vi.fn(async () => {});
    const resize = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const app = terminalsApp({ write, resize, close });
    const typed = await app.inject({
      method: "POST",
      url: `${SESSION}/terminals/${TERMINAL_ID}/input`,
      payload: { data: "ls\r\u0003" },
    });
    expect(typed.statusCode).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ data: "ls\r\u0003" }),
    );
    const resized = await app.inject({
      method: "POST",
      url: `${SESSION}/terminals/${TERMINAL_ID}/resize`,
      payload: { cols: 90, rows: 20 },
    });
    expect(resized.statusCode).toBe(200);
    expect(resize).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 90, rows: 20 }),
    );
    const closed = await app.inject({
      method: "DELETE",
      url: `${SESSION}/terminals/${TERMINAL_ID}`,
    });
    expect(closed.statusCode).toBe(200);
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: TERMINAL_ID }),
    );
    const badId = await app.inject({
      method: "DELETE",
      url: `${SESSION}/terminals/not-a-process`,
    });
    expect(badId.statusCode).toBe(400);
    await app.close();
  });

  it("answers why a workspace or terminal is not there", async () => {
    const app = terminalsApp({
      open: vi.fn(async () => {
        throw new SessionWorkspaceUnavailableError(
          "starting",
          "This chat's workspace is starting. Try again in a moment.",
        );
      }),
      read: vi.fn(async () => {
        throw new SessionTerminalNotFoundError();
      }),
      close: vi.fn(async () => {
        throw new AccessDeniedError();
      }),
    });
    const opened = await app.inject({
      method: "POST",
      url: `${SESSION}/terminals`,
      payload: {},
    });
    expect(opened.statusCode).toBe(409);
    expect(opened.json()).toEqual({
      error: "This chat's workspace is starting. Try again in a moment.",
      code: "starting",
    });
    const read = await app.inject({
      method: "GET",
      url: `${SESSION}/terminals/${TERMINAL_ID}/output`,
    });
    expect(read.statusCode).toBe(404);
    const closed = await app.inject({
      method: "DELETE",
      url: `${SESSION}/terminals/${TERMINAL_ID}`,
    });
    expect(closed.statusCode).toBe(403);
    await app.close();
  });
});

describe("preview routes (ADR 0208)", () => {
  const PREVIEW = `${SESSION}/previews/5173`;

  function previewsApp(
    request: (input: PreviewRequest) => Promise<{
      status: number;
      headers: Array<[string, string]>;
      body: Uint8Array;
    }>,
  ) {
    const spy = vi.fn(request);
    return {
      spy,
      app: createTestApp({
        core: { sessionPreviews: { request: spy } } as never,
      }),
    };
  }

  it("passes the method, path, headers and raw body through", async () => {
    const { app, spy } = previewsApp(async () => ({
      status: 201,
      headers: [
        ["Content-Type", "text/plain"],
        ["Set-Cookie", "a=1; Path=/"],
        ["Set-Cookie", "b=2; Path=/"],
        ["X-Thing", "one"],
        ["X-Thing", "two"],
        ["Content-Length", "999"],
      ],
      body: new TextEncoder().encode("created"),
    }));
    const res = await app.inject({
      method: "PUT",
      url: `${PREVIEW}/api/items%2F1?draft=yes&x=%20`,
      headers: {
        "content-type": "application/x-anything",
        cookie: "session=abc",
      },
      payload: Buffer.from([0, 1, 2, 255]),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe("created");
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers["x-thing"]).toBe("one, two");
    expect(res.headers["content-length"]).toBe("7");
    const [input] = spy.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      port: 5173,
      method: "PUT",
      path: "/api/items%2F1?draft=yes&x=%20",
    });
    expect(input?.headers).toContainEqual(["cookie", "session=abc"]);
    expect([...(input?.body ?? [])]).toEqual([0, 1, 2, 255]);
    await app.close();
  });

  it("points the server's own redirects below the preview", async () => {
    const { app } = previewsApp(async (input) => ({
      status: 302,
      headers: [
        [
          "Location",
          input.path === "/login" ? "http://localhost:5173/home?x=1" : "/login",
        ],
      ],
      body: new Uint8Array(),
    }));
    const first = await app.inject({ method: "GET", url: `${PREVIEW}/` });
    expect(first.headers.location).toBe(`${PREVIEW}/login`);
    const second = await app.inject({
      method: "POST",
      url: `${PREVIEW}/login`,
    });
    expect(second.headers.location).toBe(`${PREVIEW}/home?x=1`);
    await app.close();
  });

  it("adds the slash after the port, and refuses ports outside 1 to 65535", async () => {
    const { app } = previewsApp(async () => ({
      status: 200,
      headers: [],
      body: new Uint8Array(),
    }));
    const bare = await app.inject({ method: "GET", url: `${PREVIEW}?a=1` });
    expect(bare.statusCode).toBe(308);
    expect(bare.headers.location).toBe(`${PREVIEW}/?a=1`);
    const zero = await app.inject({
      method: "GET",
      url: `${SESSION}/previews/0/`,
    });
    expect(zero.statusCode).toBe(400);
    const high = await app.inject({
      method: "GET",
      url: `${SESSION}/previews/70000/`,
    });
    expect(high.statusCode).toBe(400);
    await app.close();
  });

  it("answers what kept the request from the server", async () => {
    const { app } = previewsApp(async (input) => {
      if (input.path === "/down")
        throw new SessionPreviewError(
          "unreachable",
          "Nothing in this chat's workspace answers on port 5173.",
        );
      throw new SessionWorkspaceUnavailableError(
        "not_running",
        "This chat's workspace is not running; send it a message to start it.",
      );
    });
    const down = await app.inject({ method: "GET", url: `${PREVIEW}/down` });
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ code: "unreachable" });
    const idle = await app.inject({ method: "GET", url: `${PREVIEW}/` });
    expect(idle.statusCode).toBe(409);
    expect(idle.json()).toMatchObject({ code: "not_running" });
    await app.close();
  });
});

describe("rewritePreviewLocation", () => {
  const prefix = "/api/projects/p/agent/sessions/s/previews/3000";
  it.each([
    ["/a?b=1#c", `${prefix}/a?b=1#c`],
    ["http://127.0.0.1:3000/x", `${prefix}/x`],
    ["http://0.0.0.0:3000/", `${prefix}/`],
    ["http://[::1]:3000/y", `${prefix}/y`],
    ["http://localhost:4000/other-port", "http://localhost:4000/other-port"],
    ["https://github.com/login", "https://github.com/login"],
    ["//cdn.example.com/x.js", "//cdn.example.com/x.js"],
    ["relative/path", "relative/path"],
  ])("%s", (location, expected) => {
    expect(rewritePreviewLocation({ location, prefix, port: 3000 })).toBe(
      expected,
    );
  });
});
