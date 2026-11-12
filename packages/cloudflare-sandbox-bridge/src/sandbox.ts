import type { Files } from "@cloudflare/sandbox";
import { startManagedProcess } from "./process.js";

export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const OPERATION_TIMEOUT_MS = 5 * 60 * 1_000;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type SandboxContainer = Pick<
  Container,
  "running" | "images" | "start" | "setInactivityTimeout" | "destroy" | "exec"
>;
type SandboxFiles = Pick<
  Files,
  "mkdir" | "writeFile" | "readFile" | "rename" | "remove"
>;

class InvalidRequest extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function environment(value: unknown): value is Record<string, string> {
  return (
    object(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function execOptions(value: unknown): {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
} {
  if (!object(value) || !strings(value.argv) || !value.argv.length)
    throw new InvalidRequest("argv must be a nonempty array of strings.");
  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== "string" || !value.cwd.startsWith("/"))
  )
    throw new InvalidRequest("cwd must be an absolute path.");
  if (value.env !== undefined && !environment(value.env))
    throw new InvalidRequest("env must contain only string values.");
  if (
    value.timeout_ms !== undefined &&
    (typeof value.timeout_ms !== "number" ||
      !Number.isSafeInteger(value.timeout_ms) ||
      value.timeout_ms <= 0 ||
      value.timeout_ms > 2_147_483_647)
  )
    throw new InvalidRequest(
      "timeout_ms must be a positive integer no greater than 2147483647.",
    );
  return {
    argv: value.argv,
    cwd: typeof value.cwd === "string" ? value.cwd : "/workspace",
    ...(environment(value.env) ? { env: value.env } : {}),
    timeoutMs:
      typeof value.timeout_ms === "number"
        ? value.timeout_ms
        : OPERATION_TIMEOUT_MS,
  };
}

function operationSignal(request: Request): AbortSignal {
  // Files scopes this signal to its shim's lifetime inside the SDK. Direct
  // native execution instead goes through startManagedProcess below.
  return AbortSignal.any([
    request.signal,
    AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  ]);
}

function failure(error: unknown): Response {
  if (
    error instanceof InvalidRequest ||
    error instanceof SyntaxError ||
    error instanceof URIError
  )
    return Response.json(
      { error: error.message, code: "invalid_request" },
      { status: 400 },
    );
  const code = object(error) ? error.code : undefined;
  return Response.json(
    {
      error:
        code === "ENOENT" ? "File not found." : "The sandbox operation failed.",
      code: code === "ENOENT" ? "not_found" : "sandbox_error",
    },
    { status: code === "ENOENT" ? 404 : 502 },
  );
}

/** Our HTTP contract over the native container API, shared by every host. */
export class SandboxBridge {
  private readonly container: SandboxContainer;
  private readonly files: SandboxFiles;
  private setup?: Promise<void>;

  constructor({
    container,
    files,
  }: { container: SandboxContainer; files: SandboxFiles }) {
    this.container = container;
    this.files = files;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      return failure(error);
    }
  }

  private async ensureRunning(): Promise<void> {
    if (!this.setup || !this.container.running) {
      this.setup = this.start().catch((error: unknown) => {
        this.setup = undefined;
        throw error;
      });
    }
    await this.setup;
  }

  private async start(): Promise<void> {
    if (!this.container.running) {
      const image = this.container.images.sandbox;
      if (!image) throw new Error("The sandbox image is not configured.");
      this.container.start({ image, instance: "lite", enableInternet: true });
    }
    try {
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      await this.container.destroy();
      throw error;
    }
  }

  private async route(request: Request): Promise<Response> {
    const route = /^\/v1\/sandbox\/[a-zA-Z0-9_-]+(.*)$/.exec(
      new URL(request.url).pathname,
    );
    const action = route?.[1];
    if (action === "" && request.method === "DELETE") {
      if (this.container.running) await this.container.destroy();
      this.setup = undefined;
      return new Response(null, { status: 204 });
    }
    if (action === "/running" && request.method === "GET")
      return Response.json({ running: this.container.running });
    if (action === "/exec" && request.method === "POST") {
      const options = execOptions(await request.json());
      await this.ensureRunning();
      return this.exec(request, options);
    }
    if (
      action?.startsWith("/file/") &&
      ["GET", "PUT"].includes(request.method)
    ) {
      const path = `/${action.slice("/file/".length).split("/").map(decodeURIComponent).join("/")}`;
      if (path.includes("\0"))
        throw new InvalidRequest("File paths must not contain NUL.");
      await this.ensureRunning();
      const signal = operationSignal(request);
      if (request.method === "GET")
        return this.files.readFile(path, { signal });
      await this.files.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
        recursive: true,
        signal,
      });
      // A cancelled upload must not truncate a previously complete file.
      const staging = `${path}.upload-${crypto.randomUUID()}`;
      try {
        await this.files.writeFile(staging, request.body ?? new Uint8Array(), {
          signal,
        });
        await this.files.rename(staging, path, { signal });
      } finally {
        await this.files
          .remove(staging, {
            force: true,
            signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
          })
          .catch(() => {});
      }
      return new Response(null, { status: 204 });
    }
    if (action === "/hydrate" && request.method === "POST") {
      if (!request.body) throw new InvalidRequest("A tar archive is required.");
      await this.ensureRunning();
      const managed = await startManagedProcess({
        container: this.container,
        argv: ["tar", "-x", "-C", "/workspace", "--no-same-owner"],
        options: { stdin: request.body },
        request,
        timeoutMs: OPERATION_TIMEOUT_MS,
      });
      let result: ExecOutput;
      try {
        result = await managed.process.output();
      } catch (error) {
        managed.stop();
        await managed.process.exitCode.catch(() => {});
        throw error;
      }
      if (result.exitCode !== 0)
        throw new Error("The workspace archive could not be extracted.");
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { error: "Sandbox route not found.", code: "not_found" },
      { status: 404 },
    );
  }

  private async exec(
    request: Request,
    options: ReturnType<typeof execOptions>,
  ): Promise<Response> {
    const managed = await startManagedProcess({
      container: this.container,
      argv: options.argv,
      options: {
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        stderr: "combined",
      },
      request,
      timeoutMs: options.timeoutMs,
    });
    const { process } = managed;
    // The process may fail while its last stdout bytes are still being read.
    void process.exitCode.catch(() => {});
    const reader = process.stdout?.getReader();
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const send = (event: string, data: string) => {
          if (!cancelled)
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
            );
        };
        try {
          if (reader) {
            const { done, value } = await reader.read();
            if (!done) {
              if (!(value instanceof Uint8Array))
                throw new Error("Invalid process output.");
              send("stdout", base64(value));
              return;
            }
          }
          const exitCode = await process.exitCode;
          if (managed.interrupted())
            send(
              "error",
              JSON.stringify({
                error: "The command timed out or was cancelled.",
              }),
            );
          else send("exit", JSON.stringify({ exit_code: exitCode }));
        } catch {
          send(
            "error",
            JSON.stringify({
              error: managed.interrupted()
                ? "The command timed out or was cancelled."
                : "The sandbox command failed.",
            }),
          );
          managed.stop();
        }
        reader?.releaseLock();
        if (!cancelled) controller.close();
      },
      async cancel(reason) {
        cancelled = true;
        managed.stop();
        await Promise.allSettled([reader?.cancel(reason), process.exitCode]);
        reader?.releaseLock();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
}
