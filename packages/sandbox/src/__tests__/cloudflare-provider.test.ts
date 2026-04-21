import { describe, expect, it, vi } from "vitest";
import {
  CloudflareSandboxError,
  CloudflareSandboxProvider,
} from "../cloudflare-provider.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function mockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
): FetchMock {
  return vi.fn<FetchLike>(async (input, init) => handler(input, init));
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function sseResponse(events: Array<{ event: string; data: string }>): Response {
  const payload = events
    .map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`)
    .join("");
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function b64(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64");
}

describe("CloudflareSandboxProvider", () => {
  it("exposes /workspace as the workspace root", () => {
    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
    });
    expect(provider.workspaceRoot).toBe("/workspace");
  });

  it("creates a sandbox via POST /v1/sandbox and sends the bearer token", async () => {
    const fetchImpl = mockFetch((input, init) => {
      expect(String(input)).toBe("http://bridge/v1/sandbox");
      expect(init?.method).toBe("POST");
      const authHeader = (init?.headers as Record<string, string>)
        .Authorization;
      expect(authHeader).toBe("Bearer secret");
      return jsonResponse({ id: "abcdef" });
    });

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "secret",
      fetch: fetchImpl,
    });

    const handle = await provider.createSandbox({});

    expect(handle.providerId).toBe("abcdef");
    expect(handle.status).toBe("started");
    expect(handle.sandboxType).toBe("execution");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("drops the Authorization header when no API key is configured", async () => {
    const fetchImpl = mockFetch((_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return jsonResponse({ id: "xyz" });
    });

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      fetch: fetchImpl,
    });

    await provider.createSandbox({});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("parses an SSE exec response into exit code + combined output", async () => {
    const fetchImpl = mockFetch((input, init) => {
      expect(String(input)).toBe("http://bridge/v1/sandbox/id1/exec");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string) as {
        argv: string[];
        timeout_ms?: number;
        cwd?: string;
      };
      expect(body.argv).toEqual(["sh", "-lc", "echo hello"]);
      expect(body.timeout_ms).toBe(5000);
      expect(body.cwd).toBe("/workspace/project");
      return sseResponse([
        { event: "stdout", data: b64("hello\n") },
        { event: "stderr", data: b64("warn\n") },
        { event: "exit", data: JSON.stringify({ exit_code: 0 }) },
      ]);
    });

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });

    const result = await provider.executeCommand("id1", "echo hello", {
      timeout: 5,
      cwd: "/workspace/project",
    });

    expect(result.exitCode).toBe(0);
    expect(result.result).toBe("hello\nwarn\n");
  });

  it("throws when the exec stream emits an error event", async () => {
    const fetchImpl = mockFetch(() =>
      sseResponse([
        {
          event: "error",
          data: JSON.stringify({ error: "boom", code: "exec_error" }),
        },
      ]),
    );

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });

    await expect(provider.executeCommand("id1", "nope")).rejects.toMatchObject({
      message: "boom",
      code: "exec_error",
    });
  });

  it("throws CloudflareSandboxError with parsed code for non-2xx JSON errors", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: "Unauthorized", code: "unauthorized" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });

    await expect(provider.createSandbox({})).rejects.toBeInstanceOf(
      CloudflareSandboxError,
    );
  });

  it("uploads files as PUT /v1/sandbox/:id/file/<abs path>", async () => {
    const writes: Array<{ url: string; body: string }> = [];
    const fetchImpl = mockFetch((input, init) => {
      writes.push({
        url: String(input),
        body: init?.body as string,
      });
      return jsonResponse({ ok: true });
    });

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });

    await provider.uploadFiles(
      "id1",
      {
        "main.ts": "export {};",
        "nested/deep.ts": "// x",
      },
      "/workspace/project",
    );

    expect(writes).toHaveLength(2);
    const urls = writes.map((w) => w.url).sort();
    expect(urls).toEqual([
      "http://bridge/v1/sandbox/id1/file/workspace/project/main.ts",
      "http://bridge/v1/sandbox/id1/file/workspace/project/nested/deep.ts",
    ]);
    const bodies = writes.map((w) => w.body).sort();
    expect(bodies).toEqual(["// x", "export {};"]);
  });

  it("keeps `@` un-encoded for scoped package paths", async () => {
    const writes: string[] = [];
    const fetchImpl = mockFetch((input) => {
      writes.push(String(input));
      return jsonResponse({ ok: true });
    });

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });

    await provider.uploadFiles(
      "id1",
      { "package.json": "{}" },
      "/workspace/project/node_modules/@opencx/workflow-sdk",
    );

    expect(writes).toEqual([
      "http://bridge/v1/sandbox/id1/file/workspace/project/node_modules/@opencx/workflow-sdk/package.json",
    ]);
  });

  it("downloadFile decodes raw bytes from the file route", async () => {
    const fetchImpl = mockFetch((input) => {
      expect(String(input)).toBe(
        "http://bridge/v1/sandbox/id1/file/workspace/project/out.txt",
      );
      return new Response("hello", {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });

    const content = await provider.downloadFile(
      "id1",
      "/workspace/project/out.txt",
    );
    expect(content).toBe("hello");
  });

  it("maps /running → SandboxStatus", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ running: true }));
    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });
    expect(await provider.getSandboxStatus("id1")).toBe("started");
  });

  it("destroySandbox tolerates 404", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(null, {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const provider = new CloudflareSandboxProvider({
      apiUrl: "http://bridge",
      apiKey: "k",
      fetch: fetchImpl,
    });
    await expect(provider.destroySandbox("gone")).resolves.toBeUndefined();
  });
});
