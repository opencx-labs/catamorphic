import { describe, expect, it, vi } from "vitest";
import { CloudflareSandboxProvider } from "../../../cloudflare/src/sandbox-provider.js";
import { bridgeRequest } from "../bridge.js";
import { startManagedProcess } from "../process.js";
import { INACTIVITY_TIMEOUT_MS, SandboxBridge } from "../sandbox.js";

function completedProcess({ output = "hello\n", exitCode = 0 } = {}) {
  const stdout = new TextEncoder().encode(output);
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(stdout);
        controller.close();
      },
    }),
    stderr: null,
    stdin: null,
    pid: 1,
    isPty: false,
    exitCode: Promise.resolve(exitCode),
    output: async () => ({
      stdout: stdout.buffer,
      stderr: new ArrayBuffer(0),
      exitCode,
    }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}

function setup() {
  type Dependencies = ConstructorParameters<typeof SandboxBridge>[0];
  const container = {
    running: false,
    images: { sandbox: "native-image" },
    start: vi.fn(() => {
      container.running = true;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    exec: vi.fn(async (_argv: string[], _options?: ContainerExecOptions) =>
      completedProcess(),
    ),
  };
  const files = {
    mkdir: vi.fn<Dependencies["files"]["mkdir"]>(async () => {}),
    writeFile: vi.fn<Dependencies["files"]["writeFile"]>(async () => {}),
    readFile: vi.fn<Dependencies["files"]["readFile"]>(
      async () => new Response("file contents"),
    ),
    rename: vi.fn<Dependencies["files"]["rename"]>(async () => {}),
    remove: vi.fn<Dependencies["files"]["remove"]>(async () => {}),
  };
  const sandbox = new SandboxBridge({ container, files });
  const sandboxes = { getByName: vi.fn(() => sandbox) };
  const fetchBridge = (request: Request) =>
    bridgeRequest({ request, apiKey: "shared", sandboxes });
  const provider = new CloudflareSandboxProvider({
    apiUrl: "https://bridge.example",
    apiKey: "shared",
    fetch: async (input, init) => fetchBridge(new Request(input, init)),
  });
  const request = (action: string, body?: unknown) =>
    fetchBridge(
      new Request(`https://bridge.example/v1/sandbox/example${action}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer shared",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    container,
    files,
    sandboxes,
    sandbox,
    fetchBridge,
    provider,
    request,
  };
}

describe("native Cloudflare sandbox bridge", () => {
  it("answers health and rejects unauthorized requests before resolving a sandbox", async () => {
    const { fetchBridge, sandboxes } = setup();
    const health = await fetchBridge(
      new Request("https://bridge.example/health"),
    );
    expect(await health.json()).toEqual({ ok: true });
    const denied = await fetchBridge(
      new Request("https://bridge.example/v1/sandbox/example/exec", {
        method: "POST",
      }),
    );
    expect(denied.status).toBe(401);
    expect(sandboxes.getByName).not.toHaveBeenCalled();
  });

  it("allows a missing key only on loopback and allocates without starting a container", async () => {
    const { sandboxes, container } = setup();
    const remote = await bridgeRequest({
      request: new Request("https://bridge.example/v1/sandbox", {
        method: "POST",
      }),
      sandboxes,
    });
    expect(remote.status).toBe(503);
    const local = await bridgeRequest({
      request: new Request("http://localhost:8787/v1/sandbox", {
        method: "POST",
      }),
      sandboxes,
    });
    expect(local.status).toBe(201);
    expect(await local.json()).toEqual({ id: expect.any(String) });
    expect(sandboxes.getByName).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
  });

  it("runs the public provider over native exec with per-command env and streamed output", async () => {
    const { provider, container, sandboxes } = setup();
    const result = await provider.executeCommand("example", "echo hello", {
      cwd: "/workspace/project",
      env: { VALUE: "$(untrusted-shell-syntax)" },
      timeout: 7,
    });
    expect(result).toEqual({ result: "hello\n", exitCode: 0 });
    expect(sandboxes.getByName).toHaveBeenCalledWith("example");
    expect(container.start).toHaveBeenCalledWith({
      image: "native-image",
      instance: "lite",
      enableInternet: true,
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(
      INACTIVITY_TIMEOUT_MS,
    );
    expect(container.exec).toHaveBeenCalledWith(
      ["timeout", "--signal=KILL", "--", "7s", "sh", "-lc", "echo hello"],
      {
        cwd: "/workspace/project",
        env: { VALUE: "$(untrusted-shell-syntax)" },
        stderr: "combined",
      },
    );
    await provider.executeCommand("example", "pwd");
    expect(container.exec).toHaveBeenLastCalledWith(
      ["timeout", "--signal=KILL", "--", "300s", "sh", "-lc", "pwd"],
      {
        cwd: "/workspace",
        stderr: "combined",
      },
    );
    expect(container.start).toHaveBeenCalledOnce();
  });

  it("reports a nonzero native exit without treating it as a transport failure", async () => {
    const { provider, container } = setup();
    container.exec.mockResolvedValueOnce(
      completedProcess({ output: "failed\n", exitCode: 9 }),
    );
    expect(await provider.executeCommand("example", "exit 9")).toEqual({
      result: "failed\n",
      exitCode: 9,
    });
  });

  it("rejects malformed exec input before starting a container", async () => {
    const { request, container } = setup();
    for (const body of [
      null,
      { argv: [] },
      { argv: ["pwd"], env: { VALUE: 1 } },
      { argv: ["pwd"], timeout_ms: -1 },
      { argv: ["pwd"], cwd: "relative" },
    ]) {
      expect((await request("/exec", body)).status).toBe(400);
    }
    expect(container.start).not.toHaveBeenCalled();
  });

  it("creates parent directories and atomically replaces an uploaded file", async () => {
    const { provider, files } = setup();
    await provider.uploadFiles(
      "example",
      { "nested/a b.txt": "new contents" },
      "/workspace/@scope",
    );
    expect(files.mkdir).toHaveBeenCalledWith("/workspace/@scope/nested", {
      recursive: true,
      signal: expect.any(AbortSignal),
    });
    const [staging, body] = files.writeFile.mock.calls[0] ?? [];
    expect(staging).toMatch(/^\/workspace\/@scope\/nested\/a b\.txt\.upload-/);
    expect(body).toBeInstanceOf(ReadableStream);
    expect(files.rename).toHaveBeenCalledWith(
      staging,
      "/workspace/@scope/nested/a b.txt",
      { signal: expect.any(AbortSignal) },
    );
    expect(files.remove).toHaveBeenCalledWith(staging, {
      force: true,
      signal: expect.any(AbortSignal),
    });
    expect(
      await provider.downloadFile(
        "example",
        "/workspace/@scope/nested/a b.txt",
      ),
    ).toBe("file contents");
    expect(files.readFile).toHaveBeenCalledWith(
      "/workspace/@scope/nested/a b.txt",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("preserves the original file when an upload fails", async () => {
    const { provider, files } = setup();
    files.writeFile.mockRejectedValueOnce(new Error("upload disconnected"));
    await expect(
      provider.uploadFiles(
        "example",
        { "existing.txt": "partial" },
        "/workspace",
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(files.rename).not.toHaveBeenCalled();
    expect(files.remove).toHaveBeenCalledOnce();
  });

  it("streams a workspace tar to native exec and refuses failed extraction", async () => {
    const { provider, container } = setup();
    await provider.hydrateWorkspace("example", new Uint8Array([1, 2, 3]));
    expect(container.exec).toHaveBeenCalledWith(
      [
        "timeout",
        "--signal=KILL",
        "--",
        "300s",
        "tar",
        "-x",
        "-C",
        "/workspace",
        "--no-same-owner",
      ],
      {
        stdin: expect.any(ReadableStream),
      },
    );
    container.exec.mockResolvedValueOnce(completedProcess({ exitCode: 2 }));
    await expect(
      provider.hydrateWorkspace("example", new Uint8Array([1])),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("reports liveness without starting, destroys immediately, and restarts lazily", async () => {
    const { provider, container } = setup();
    expect(await provider.getSandboxStatus("example")).toBe("stopped");
    expect(container.start).not.toHaveBeenCalled();
    await provider.executeCommand("example", "pwd");
    expect(await provider.getSandboxStatus("example")).toBe("started");
    await provider.destroySandbox("example");
    expect(container.destroy).toHaveBeenCalledOnce();
    expect(await provider.getSandboxStatus("example")).toBe("stopped");
    await provider.executeCommand("example", "pwd");
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it("destroys a partially configured container and retries setup on the next request", async () => {
    const { provider, container } = setup();
    container.setInactivityTimeout.mockRejectedValueOnce(
      new Error("setup failed"),
    );
    await expect(
      provider.executeCommand("example", "pwd"),
    ).rejects.toMatchObject({ status: 502 });
    expect(container.destroy).toHaveBeenCalledOnce();
    expect(container.exec).not.toHaveBeenCalled();
    expect((await provider.executeCommand("example", "pwd")).exitCode).toBe(0);
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it("cancels native execution when the client stops reading its response", async () => {
    const { request, container } = setup();
    const output = new ReadableStream<Uint8Array>();
    const exited = Promise.withResolvers<number>();
    const kill = vi.fn(() => exited.resolve(137));
    container.exec.mockResolvedValueOnce({
      ...completedProcess(),
      stdout: output,
      exitCode: exited.promise,
      kill,
    });
    const response = await request("/exec", { argv: ["sleep", "60"] });
    const options = container.exec.mock.calls[0]?.[1];
    expect(options?.signal).toBeUndefined();
    await response.body?.cancel();
    expect(kill).toHaveBeenCalledExactlyOnceWith(14);
  });

  it("enforces the command deadline through the timeout process group", async () => {
    const { provider, container } = setup();
    container.exec.mockResolvedValueOnce(
      completedProcess({ output: "", exitCode: 137 }),
    );
    expect(
      await provider.executeCommand("example", "sleep 60", { timeout: 0.001 }),
    ).toEqual({ exitCode: 137, result: "" });
    expect(container.exec).toHaveBeenCalledWith(
      ["timeout", "--signal=KILL", "--", "0.001s", "sh", "-lc", "sleep 60"],
      { cwd: "/workspace", stderr: "combined" },
    );
  });

  it("explicitly forwards request cancellation across the Worker and Durable Object boundary", async () => {
    const { container, sandbox } = setup();
    const exited = Promise.withResolvers<number>();
    let stopOutput = () => {};
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ready"));
        stopOutput = () => controller.close();
      },
    });
    const kill = vi.fn(() => {
      stopOutput();
      exited.resolve(137);
    });
    container.exec.mockResolvedValueOnce({
      ...completedProcess(),
      stdout,
      exitCode: exited.promise,
      kill,
    });
    const controller = new AbortController();
    const response = await bridgeRequest({
      request: new Request("https://bridge.example/v1/sandbox/example/exec", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer shared",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ argv: ["sleep", "60"] }),
      }),
      apiKey: "shared",
      sandboxes: {
        getByName: () => ({
          fetch: (request, init) =>
            // Workers do not inherit the incoming Request signal by default.
            sandbox.fetch(
              new Request(request, {
                signal: init?.signal ?? new AbortController().signal,
              }),
            ),
        }),
      },
    });
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    controller.abort();
    const final = await reader?.read();
    expect(new TextDecoder().decode(final?.value)).toContain("was cancelled");
    expect(kill).toHaveBeenCalledExactlyOnceWith(14);
    await reader?.cancel();
  });

  it("retains no Worker deadline or request listener after a completed command", async () => {
    vi.useFakeTimers();
    try {
      const child = completedProcess();
      const container = { exec: vi.fn(async () => child) };
      const controller = new AbortController();
      const request = new Request("https://bridge.example/exec", {
        signal: controller.signal,
      });
      const removed = vi.spyOn(request.signal, "removeEventListener");
      const managed = await startManagedProcess({
        container,
        argv: ["true"],
        request,
        timeoutMs: 1_000,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
      controller.abort();
      managed.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("also removes lifetime controls when native startup or exit fails", async () => {
    vi.useFakeTimers();
    try {
      const request = new Request("https://bridge.example/exec");
      const failure = new Error("native failure");
      await expect(
        startManagedProcess({
          container: {
            exec: async () => {
              throw failure;
            },
          },
          argv: ["true"],
          request,
          timeoutMs: 1_000,
        }),
      ).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
      const child = {
        ...completedProcess(),
        exitCode: Promise.reject(failure),
      };
      const managed = await startManagedProcess({
        container: { exec: async () => child },
        argv: ["true"],
        request,
        timeoutMs: 1_000,
      });
      expect(vi.getTimerCount()).toBe(0);
      managed.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
