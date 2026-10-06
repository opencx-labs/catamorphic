import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DockerClient } from "../docker-client.js";
import { dockerFrame } from "../stream-demux.js";

/** A container as the fake daemon keeps it. */
export interface FakeContainer {
  id: string;
  body: Record<string, unknown>;
  running: boolean;
  /** The kernel killed it for memory. */
  oomKilled?: boolean;
}

/**
 * A Docker Engine API on a Unix socket that keeps containers, volumes,
 * networks and execs in memory: enough of the daemon for the container
 * provider's own logic, with no Docker. Every exec succeeds with no output
 * unless `onExec` answers otherwise.
 */
export async function startFakeDocker(options?: {
  /** The image's `Config`. */
  image?: { User?: string; Env?: string[] };
  /** Fail container starts with this message. */
  failStart?: string;
  /** How an exec ends, when not with success and no output. */
  onExec?: (exec: {
    container: FakeContainer;
    cmd: string[];
  }) => { exitCode: number; stderr?: string } | undefined;
}) {
  // Unix socket paths are short; macOS's temporary directory is not.
  const directory = fs.mkdtempSync(
    path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "wfd-"),
  );
  const socketPath = path.join(directory, "docker.sock");
  const containers = new Map<string, FakeContainer>();
  const volumes = new Map<string, Record<string, unknown>>();
  const networks = new Map<string, Record<string, unknown>>();
  const execs = new Map<
    string,
    { container: string; cmd: string[]; exitCode?: number }
  >();
  const requests: string[] = [];
  let nextExec = 0;

  const labelFilter = (query: string | null): string[] => {
    if (!query) return [];
    const parsed: unknown = JSON.parse(query);
    const labels =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "label")
        : undefined;
    return Array.isArray(labels) ? labels.map(String) : [];
  };
  const matches = (labels: Record<string, unknown>, wanted: string[]) =>
    wanted.every((entry) => {
      const [key = "", value] = entry.split("=");
      return value === undefined ? key in labels : labels[key] === value;
    });
  const labelsOf = (body: Record<string, unknown>): Record<string, unknown> => {
    const labels = body.Labels;
    return typeof labels === "object" && labels !== null
      ? Object.fromEntries(Object.entries(labels))
      : {};
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://docker");
      const route = `${request.method} ${url.pathname}`;
      requests.push(route);
      const text = Buffer.concat(chunks).toString("utf8");
      const body: Record<string, unknown> = text ? JSON.parse(text) : {};
      const json = (status: number, value?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      const containerMatch = url.pathname.match(
        /^\/containers\/([^/]+)(\/[a-z]+)?$/,
      );
      if (route === "GET /_ping") return response.end("OK");
      if (/^GET \/images\/.+\/json$/.test(route))
        return json(200, { Config: options?.image ?? {} });
      if (route === "POST /volumes/create") {
        const name = String(body.Name);
        if (!volumes.has(name)) volumes.set(name, labelsOf(body));
        return json(201, { Name: name });
      }
      if (route === "GET /volumes") {
        const wanted = labelFilter(url.searchParams.get("filters"));
        return json(200, {
          Volumes: [...volumes]
            .filter(([, labels]) => matches(labels, wanted))
            .map(([Name, Labels]) => ({ Name, Labels })),
        });
      }
      const volumeMatch = url.pathname.match(/^\/volumes\/(.+)$/);
      if (request.method === "DELETE" && volumeMatch) {
        const name = decodeURIComponent(volumeMatch[1] ?? "");
        const used = [...containers.values()].some((container) =>
          JSON.stringify(container.body).includes(`"Source":"${name}"`),
        );
        if (used) return json(409, { message: "volume is in use" });
        volumes.delete(name);
        return json(204);
      }
      const networkMatch = url.pathname.match(/^\/networks\/([^/]+)$/);
      if (request.method === "GET" && networkMatch) {
        const network = networks.get(decodeURIComponent(networkMatch[1] ?? ""));
        return network ? json(200, network) : json(404, { message: "none" });
      }
      if (route === "POST /networks/create") {
        networks.set(String(body.Name), {
          Name: body.Name,
          Labels: body.Labels,
          Options: body.Options,
        });
        return json(201, { Id: body.Name });
      }
      if (route === "POST /containers/create") {
        const id = url.searchParams.get("name") ?? `c${containers.size}`;
        containers.set(id, { id, body, running: false });
        return json(201, { Id: id });
      }
      if (route === "GET /containers/json") {
        const wanted = labelFilter(url.searchParams.get("filters"));
        return json(
          200,
          [...containers.values()]
            .filter((container) => matches(labelsOf(container.body), wanted))
            .map((container) => ({
              Id: container.id,
              Names: [`/${container.id}`],
            })),
        );
      }
      if (containerMatch) {
        const id = decodeURIComponent(containerMatch[1] ?? "");
        const container = containers.get(id);
        const action = containerMatch[2];
        if (!container)
          return json(404, { message: `No such container: ${id}` });
        if (request.method === "DELETE") {
          containers.delete(id);
          return json(204);
        }
        if (action === "/start") {
          if (options?.failStart)
            return json(500, { message: options.failStart });
          container.running = true;
          return json(204);
        }
        if (action === "/stop") {
          container.running = false;
          return json(204);
        }
        if (action === "/json") {
          const hostConfig = Reflect.get(container.body, "HostConfig");
          const mounts =
            typeof hostConfig === "object" && hostConfig !== null
              ? Reflect.get(hostConfig, "Mounts")
              : [];
          return json(200, {
            Config: {
              ...(options?.image ?? {}),
              Labels: labelsOf(container.body),
            },
            State: {
              Running: container.running,
              Status: container.running ? "running" : "exited",
              OOMKilled: container.oomKilled === true,
            },
            Mounts: (Array.isArray(mounts) ? mounts : []).map(
              (mount: Record<string, unknown>) => ({
                Type: mount.Type,
                Destination: mount.Target,
                ...(mount.Source ? { Name: mount.Source } : {}),
              }),
            ),
          });
        }
        if (action === "/exec") {
          if (!container.running)
            return json(409, {
              message: `container ${id} is not running`,
            });
          const execId = `e${nextExec++}`;
          const cmd = body.Cmd;
          execs.set(execId, {
            container: id,
            cmd: Array.isArray(cmd) ? cmd.map(String) : [],
          });
          return json(201, { Id: execId });
        }
      }
      const execMatch = url.pathname.match(/^\/exec\/([^/]+)\/json$/);
      if (execMatch)
        return json(200, {
          Running: false,
          ExitCode: execs.get(execMatch[1] ?? "")?.exitCode ?? 0,
        });
      return json(500, { message: `The fake daemon has no ${route}` });
    });
  });
  // Exec streams: no output (or what onExec says), then the end.
  server.on("upgrade", (request, socket) => {
    requests.push(`${request.method} ${request.url} upgrade`);
    socket.on("error", () => {});
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    const exec = execs.get(request.url?.match(/^\/exec\/([^/]+)\//)?.[1] ?? "");
    const container = exec ? containers.get(exec.container) : undefined;
    const ended =
      exec && container
        ? options?.onExec?.({ container, cmd: exec.cmd })
        : undefined;
    if (exec && ended) exec.exitCode = ended.exitCode;
    socket.end(
      ended?.stderr
        ? dockerFrame(2, Buffer.from(ended.stderr))
        : dockerFrame(1, Buffer.alloc(0)),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(socketPath, () => resolve()),
  );
  return {
    docker: new DockerClient({ socketPath }),
    directory,
    containers,
    volumes,
    networks,
    execs,
    requests,
    /** Every exec's argv, in order. */
    commands: () => [...execs.values()].map((exec) => exec.cmd),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
