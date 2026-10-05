import http from "node:http";
import net from "node:net";
import { type DockerStream, DockerStreamDemuxer } from "./stream-demux.js";
import { tarArchive } from "./tar.js";

/** Where the Docker Engine API answers: a Unix socket, or plain TCP. */
export type DockerEndpoint =
  | { socketPath: string }
  | { host: string; port: number };

const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * The endpoint `DOCKER_HOST` names (`unix:///path` or `tcp://host:port`),
 * or Docker's default socket. TLS endpoints and SSH are not supported:
 * mount the daemon's socket instead.
 */
export function dockerEndpoint(dockerHost?: string): DockerEndpoint {
  if (!dockerHost) return { socketPath: DEFAULT_SOCKET };
  if (dockerHost.startsWith("unix://")) {
    const socketPath = dockerHost.slice("unix://".length);
    if (!socketPath.startsWith("/"))
      throw new Error(`DOCKER_HOST '${dockerHost}' must name an absolute path`);
    return { socketPath };
  }
  if (dockerHost.startsWith("tcp://")) {
    const url = new URL(`http://${dockerHost.slice("tcp://".length)}`);
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new Error(
    `DOCKER_HOST '${dockerHost}' is not supported: use unix:///path/to/docker.sock or tcp://host:port`,
  );
}

/** An answer of the Docker Engine API outside 2xx. */
export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

/** One frame of an exec's output. */
export interface ExecFrame {
  stream: DockerStream;
  data: Buffer;
}

/** A started exec: its output, its input, and its end. */
export interface ExecSession {
  readonly execId: string;
  /** Output frames until the command ends and Docker closes the stream. */
  readonly frames: AsyncIterable<ExecFrame>;
  /**
   * Write to the command's input (exec created with `stdin`). The input is
   * never closed: Bun's sockets cannot half-close, so a command reads only
   * as much input as it was told to (`head -c <bytes>`), or reads until it
   * is stopped.
   */
  write(data: Uint8Array | string): Promise<void>;
  /** Drop the connection; the command keeps running. */
  close(): void;
}

export interface ExecRequest {
  container: string;
  cmd: readonly string[];
  env?: Record<string, string>;
  workingDir?: string;
  /** User to run as; the container's own by default. */
  user?: string;
  /** Keep standard input open for {@link ExecSession.write}. */
  stdin?: boolean;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * The few Docker Engine API calls the container backend needs, over
 * `node:http` (Unix socket or TCP) with no client library. Exec streams
 * hijack the connection with Docker's `Upgrade: tcp` handshake on a raw
 * socket, which Bun and Node both support.
 */
export class DockerClient {
  constructor(readonly endpoint: DockerEndpoint = dockerEndpoint()) {}

  /** A JSON request; a status outside 2xx (and not in `accept`) throws. */
  async json(args: {
    method: string;
    path: string;
    body?: unknown;
    accept?: readonly number[];
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }> {
    const payload =
      args.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(args.body));
    const response = await this.send({
      method: args.method,
      path: args.path,
      headers: payload
        ? {
            "content-type": "application/json",
            "content-length": String(payload.length),
          }
        : {},
      ...(payload ? { body: payload } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    const text = response.body.toString("utf8");
    const body = parseJson(text);
    if (
      (response.status < 200 || response.status >= 300) &&
      !args.accept?.includes(response.status)
    )
      throw new DockerApiError(
        response.status,
        `Docker answered ${response.status} to ${args.method} ${args.path.split("?")[0]}: ${errorMessage(body, text)}`,
      );
    return { status: response.status, body };
  }

  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.send({
        method: "GET",
        path: "/_ping",
        headers: {},
        signal: signal ?? AbortSignal.timeout(5_000),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async info(): Promise<Record<string, unknown>> {
    return record(
      (await this.json({ method: "GET", path: "/info" })).body,
      "Docker info",
    );
  }

  /** The image's inspection, or undefined when this machine lacks it. */
  async inspectImage(
    reference: string,
  ): Promise<Record<string, unknown> | undefined> {
    const answer = await this.json({
      method: "GET",
      path: `/images/${encodeURIComponent(reference)}/json`,
      accept: [404],
    });
    return answer.status === 404
      ? undefined
      : record(answer.body, "Image inspection");
  }

  /** Pull an image, reading Docker's progress to its end; errors in it throw. */
  async pullImage(reference: string): Promise<void> {
    const response = await this.send({
      method: "POST",
      path: `/images/create?fromImage=${encodeURIComponent(withTag(reference))}`,
      headers: { "content-length": "0" },
    });
    const failure = progressError(response.body);
    if (response.status !== 200 || failure)
      throw new Error(
        `Pulling ${reference} failed: ${failure ?? errorMessage(parseJson(response.body.toString("utf8")), response.body.toString("utf8"))}`,
      );
  }

  /**
   * Build a Dockerfile into `tag` with the Dockerfile alone as its context
   * (ADR 0176), with the classic builder.
   */
  async buildImage(args: { tag: string; dockerfile: string }): Promise<void> {
    const context = tarArchive([
      { path: "Dockerfile", content: args.dockerfile },
    ]);
    const response = await this.send({
      method: "POST",
      path: `/build?t=${encodeURIComponent(args.tag)}&rm=1&forcerm=1`,
      headers: {
        "content-type": "application/x-tar",
        "content-length": String(context.length),
      },
      body: context,
    });
    const failure = progressError(response.body);
    if (response.status !== 200 || failure)
      throw new Error(
        `Image build failed: ${(failure ?? response.body.toString("utf8")).slice(-2000)}`,
      );
  }

  async createContainer(args: {
    name: string;
    body: unknown;
  }): Promise<string> {
    const answer = await this.json({
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(args.name)}`,
      body: args.body,
    });
    const id = record(answer.body, "Container creation").Id;
    if (typeof id !== "string") throw new Error("Docker returned no container");
    return id;
  }

  /** The container's inspection, or undefined when it does not exist. */
  async inspectContainer(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const answer = await this.json({
      method: "GET",
      path: `/containers/${encodeURIComponent(id)}/json`,
      accept: [404],
    });
    return answer.status === 404
      ? undefined
      : record(answer.body, "Container inspection");
  }

  async startContainer(id: string): Promise<void> {
    // 304: already running.
    await this.json({
      method: "POST",
      path: `/containers/${encodeURIComponent(id)}/start`,
      accept: [304],
    });
  }

  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    await this.json({
      method: "POST",
      path: `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`,
      accept: [304],
    });
  }

  /** Remove a container and its anonymous volumes; a missing one is gone already. */
  async removeContainer(id: string): Promise<void> {
    await this.json({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(id)}?force=1&v=1`,
      accept: [404],
    });
  }

  async listContainers(
    filters: Record<string, string[]>,
  ): Promise<Array<Record<string, unknown>>> {
    const answer = await this.json({
      method: "GET",
      path: `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`,
    });
    return Array.isArray(answer.body)
      ? answer.body.map((item) => record(item, "Container"))
      : [];
  }

  async createVolume(args: {
    name: string;
    labels?: Record<string, string>;
  }): Promise<void> {
    await this.json({
      method: "POST",
      path: "/volumes/create",
      body: { Name: args.name, Labels: args.labels ?? {} },
    });
  }

  async listVolumes(
    filters: Record<string, string[]>,
  ): Promise<Array<Record<string, unknown>>> {
    const answer = await this.json({
      method: "GET",
      path: `/volumes?filters=${encodeURIComponent(JSON.stringify(filters))}`,
    });
    const volumes = record(answer.body, "Volume list").Volumes;
    return Array.isArray(volumes)
      ? volumes.map((item) => record(item, "Volume"))
      : [];
  }

  /** Remove a named volume; false while a container still uses it. */
  async removeVolume(name: string): Promise<boolean> {
    const answer = await this.json({
      method: "DELETE",
      path: `/volumes/${encodeURIComponent(name)}`,
      accept: [404, 409],
    });
    return answer.status !== 409;
  }

  /**
   * Start a command in a running container. The connection is hijacked
   * (`Upgrade: tcp`), so input and output flow both ways until the command
   * ends.
   */
  async openExec(request: ExecRequest): Promise<ExecSession> {
    const created = await this.json({
      method: "POST",
      path: `/containers/${encodeURIComponent(request.container)}/exec`,
      body: {
        AttachStdin: Boolean(request.stdin),
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: request.cmd,
        ...(request.env
          ? {
              Env: Object.entries(request.env).map(
                ([name, value]) => `${name}=${value}`,
              ),
            }
          : {}),
        ...(request.workingDir ? { WorkingDir: request.workingDir } : {}),
        ...(request.user ? { User: request.user } : {}),
      },
    });
    const execId = record(created.body, "Exec creation").Id;
    if (typeof execId !== "string") throw new Error("Docker returned no exec");
    const socket = await this.hijack({
      path: `/exec/${execId}/start`,
      body: Buffer.from(JSON.stringify({ Detach: false, Tty: false })),
    });
    const demuxer = new DockerStreamDemuxer();
    const frames: AsyncIterable<ExecFrame> = {
      [Symbol.asyncIterator]: () => frameIterator({ socket, demuxer }),
    };
    return {
      execId,
      frames,
      write: (data) =>
        new Promise<void>((resolve, reject) => {
          socket.write(data, (error) => (error ? reject(error) : resolve()));
        }),
      close: () => {
        socket.destroy();
      },
    };
  }

  /** An exec's exit code once it has ended; null while it still runs. */
  async execExitCode(execId: string): Promise<number | null> {
    const inspected = record(
      (await this.json({ method: "GET", path: `/exec/${execId}/json` })).body,
      "Exec inspection",
    );
    if (inspected.Running === true) return null;
    return typeof inspected.ExitCode === "number" ? inspected.ExitCode : null;
  }

  /**
   * Run a command to its end and collect its output (at most `maxBytes` of
   * each stream). `input` is written to its standard input, which stays
   * open: the command must read exactly its length (see
   * {@link ExecSession.write}).
   */
  async exec(
    request: Omit<ExecRequest, "stdin"> & {
      input?: Uint8Array;
      maxBytes?: number;
    },
  ): Promise<ExecOutput> {
    const session = await this.openExec({
      ...request,
      stdin: request.input !== undefined,
    });
    if (request.input !== undefined) await session.write(request.input);
    const limit = request.maxBytes ?? 16 * 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    for await (const frame of session.frames) {
      if (frame.stream === "stdout" && outBytes < limit) {
        out.push(frame.data.subarray(0, limit - outBytes));
        outBytes += frame.data.length;
      } else if (frame.stream === "stderr" && errBytes < limit) {
        err.push(frame.data.subarray(0, limit - errBytes));
        errBytes += frame.data.length;
      }
    }
    return {
      exitCode: await this.settledExitCode(session.execId),
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    };
  }

  /**
   * The exit code of an exec whose stream ended. Docker may report it a
   * moment after the stream closes.
   */
  async settledExitCode(execId: string): Promise<number> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const code = await this.execExitCode(execId);
      if (code !== null) return code;
      if (Date.now() > deadline)
        throw new Error("Docker did not report how the command ended");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private send(args: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          ...("socketPath" in this.endpoint
            ? { socketPath: this.endpoint.socketPath }
            : { host: this.endpoint.host, port: this.endpoint.port }),
          method: args.method,
          path: args.path,
          headers: { host: "docker", ...args.headers },
          ...(args.signal ? { signal: args.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 502,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(args.body);
    });
  }

  /**
   * POST with Docker's hijack handshake on a raw socket. Resolves once the
   * daemon answered 101 (or 200), with the socket carrying the raw stream.
   */
  private hijack(args: { path: string; body: Buffer }): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket =
        "socketPath" in this.endpoint
          ? net.createConnection({ path: this.endpoint.socketPath })
          : net.createConnection({
              host: this.endpoint.host,
              port: this.endpoint.port,
            });
      let head = Buffer.alloc(0);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.length > 64 * 1024)
            fail(new Error("Docker sent an oversized response header"));
          return;
        }
        socket.off("data", onData);
        socket.off("error", fail);
        const status = Number(
          head.subarray(0, end).toString("latin1").split(" ")[1],
        );
        const rest = head.subarray(end + 4);
        if (status === 101 || status === 200) {
          socket.pause();
          if (rest.length > 0) socket.unshift(rest);
          // Reading the stream reports its errors; until then none may
          // escape as an unhandled event.
          socket.on("error", () => {});
          resolve(socket);
          return;
        }
        // An error answers with a JSON body; read what arrives.
        const body: Buffer[] = [rest];
        let answered = false;
        const done = () => {
          if (answered) return;
          answered = true;
          const text = Buffer.concat(body).toString("utf8");
          socket.destroy();
          reject(
            new DockerApiError(
              status,
              `Docker answered ${status} starting a command: ${errorMessage(parseJson(lastLine(text)), text)}`,
            ),
          );
        };
        socket.on("data", (more: Buffer) => body.push(more));
        socket.once("end", done);
        socket.once("error", done);
        setTimeout(done, 2_000).unref();
      };
      socket.on("data", onData);
      socket.on("error", fail);
      socket.once("connect", () => {
        socket.write(
          [
            `POST ${args.path} HTTP/1.1`,
            "Host: docker",
            "Content-Type: application/json",
            "Connection: Upgrade",
            "Upgrade: tcp",
            `Content-Length: ${args.body.length}`,
            "",
            "",
          ].join("\r\n"),
        );
        socket.write(args.body);
      });
    });
  }
}

async function* frameIterator(args: {
  socket: net.Socket;
  demuxer: DockerStreamDemuxer;
}): AsyncGenerator<ExecFrame> {
  const { socket, demuxer } = args;
  socket.resume();
  try {
    for await (const chunk of socket) {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const frame of demuxer.push(data)) yield frame;
    }
  } catch (error) {
    // A reset after the command ended loses nothing; earlier it does.
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ECONNRESET" || error.code === "EPIPE")
      )
    )
      throw error;
  } finally {
    socket.destroy();
  }
}

/** Docker pulls every tag of a reference without one; name `latest`. */
export function withTag(reference: string): string {
  if (reference.includes("@")) return reference;
  const lastSegment = reference.slice(reference.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? reference : `${reference}:latest`;
}

/** The first error a progress stream (pull, build) reports. */
function progressError(body: Buffer): string | undefined {
  for (const line of body.toString("utf8").split("\n")) {
    const parsed = parseJson(line.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const error = parsed.error ?? parsed.errorDetail;
      if (typeof error === "string") return error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const message = error.message;
        if (typeof message === "string") return message;
      }
    }
  }
  return undefined;
}

function parseJson(text: string): Json | undefined {
  if (!text) return undefined;
  try {
    const parsed: Json = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

function errorMessage(body: Json | undefined, text: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const message = body.message;
    if (typeof message === "string") return message;
  }
  return text.trim().slice(0, 500) || "no details";
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${what}: Docker returned an unexpected answer`);
  return Object.fromEntries(Object.entries(value));
}
