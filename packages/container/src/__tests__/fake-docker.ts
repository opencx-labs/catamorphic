import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
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
 * unless `onExec` answers otherwise, but for the agent side's runtime
 * probe, which finds Bun (ADR 0332).
 */
export async function startFakeDocker(options?: {
  /** The image's `Config`. */
  image?: { User?: string; Env?: string[] };
  /** Fail container starts with this message. */
  failStart?: string;
  /** Awaited before a container is created, to hold a creation midway. */
  beforeCreateContainer?: (body: Record<string, unknown>) => Promise<void>;
  /** How an exec ends, when not with success and no output. */
  onExec?: (exec: {
    container: FakeContainer;
    cmd: string[];
  }) => { exitCode: number; stdout?: string; stderr?: string } | undefined;
  /**
   * Keep images (ADR 0335): only these exist at first, with when each was
   * made (Unix seconds); pulls and builds add to them. Without it every
   * image exists.
   */
  images?: Record<string, number>;
  /** What `/info` names as Docker's data root. */
  dockerRootDir?: string;
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
  const images = options?.images
    ? new Map<string, number>(Object.entries(options.images))
    : undefined;
  /** Labels a build or a test gave each image, by reference. */
  const imageLabels = new Map<string, Record<string, string>>();
  /** Which image each reference names: its own unless a tag shares one. */
  const imageIds = new Map<string, string>();
  const idOf = (reference: string) => imageIds.get(reference) ?? reference;
  const sameImage = (reference: string) =>
    [...(images?.keys() ?? [])].filter(
      (other) => idOf(other) === idOf(reference),
    );
  /** Exec streams, which the HTTP server no longer tracks once upgraded. */
  const upgraded = new Set<Duplex>();
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
      // A build's body is a tar archive, not JSON.
      const body: Record<string, unknown> =
        text && route !== "POST /build" ? JSON.parse(text) : {};
      const json = (status: number, value?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      const containerMatch = url.pathname.match(
        /^\/containers\/([^/]+)(\/[a-z]+)?$/,
      );
      if (route === "GET /_ping") return response.end("OK");
      if (route === "GET /info")
        return json(200, {
          DockerRootDir: options?.dockerRootDir ?? "/var/lib/docker",
        });
      if (route === "GET /images/json") {
        const filters: unknown = JSON.parse(
          url.searchParams.get("filters") ?? "{}",
        );
        const wanted =
          typeof filters === "object" && filters !== null
            ? Reflect.get(filters, "reference")
            : undefined;
        const prefix = Array.isArray(wanted) ? String(wanted[0] ?? "") : "";
        const ids = new Set(
          [...(images?.keys() ?? [])]
            .filter(
              (reference) =>
                !prefix ||
                reference === prefix ||
                reference.startsWith(`${prefix}:`),
            )
            .map(idOf),
        );
        return json(
          200,
          [...ids].map((id) => {
            const tags = [...(images?.keys() ?? [])].filter(
              (reference) => idOf(reference) === id,
            );
            const first = tags[0] ?? id;
            return {
              Id: id,
              RepoTags: tags,
              Created: images?.get(first) ?? 0,
              Labels: imageLabels.get(first) ?? null,
            };
          }),
        );
      }
      const tagMatch = url.pathname.match(/^\/images\/(.+)\/tag$/);
      if (request.method === "POST" && tagMatch) {
        const source = decodeURIComponent(tagMatch[1] ?? "");
        if (!images?.has(source))
          return json(404, { message: `No such image: ${source}` });
        const target = `${url.searchParams.get("repo")}:${url.searchParams.get("tag")}`;
        images.set(target, images.get(source) ?? 0);
        imageIds.set(target, idOf(source));
        return json(201);
      }
      const imageMatch = url.pathname.match(/^\/images\/(.+?)(\/json)?$/);
      if (request.method === "GET" && imageMatch?.[2]) {
        const reference = decodeURIComponent(imageMatch[1] ?? "");
        if (images && !images.has(reference))
          return json(404, { message: `No such image: ${reference}` });
        return json(200, {
          Id: idOf(reference),
          RepoTags: images ? sameImage(reference) : [reference],
          Config: {
            ...(options?.image ?? {}),
            Labels: imageLabels.get(reference) ?? null,
          },
        });
      }
      if (route === "POST /images/create") {
        const reference = url.searchParams.get("fromImage") ?? "";
        images?.set(reference.replace(/:latest$/, ""), Date.now() / 1000);
        images?.set(reference, Date.now() / 1000);
        return json(200, { status: "pulled" });
      }
      if (route === "POST /build") {
        const tag = url.searchParams.get("t") ?? "";
        images?.set(tag, Date.now() / 1000);
        const labels: unknown = JSON.parse(
          url.searchParams.get("labels") ?? "{}",
        );
        if (labels && typeof labels === "object")
          imageLabels.set(
            tag,
            Object.fromEntries(
              Object.entries(labels).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
          );
        return json(200, { stream: "built" });
      }
      if (request.method === "DELETE" && imageMatch && !imageMatch[2]) {
        const reference = decodeURIComponent(imageMatch[1] ?? "");
        if (!images?.has(reference))
          return json(404, { message: `No such image: ${reference}` });
        // Another reference keeps the image: this one is only untagged.
        const shared = sameImage(reference).length > 1;
        const used = [...containers.values()].some((container) =>
          sameImage(reference).includes(String(container.body.Image)),
        );
        if (used && !shared)
          return json(409, {
            message: `conflict: unable to remove ${reference}: image is being used by a container`,
          });
        images.delete(reference);
        return json(200, [{ Untagged: reference }]);
      }
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
        void (options?.beforeCreateContainer?.(body) ?? Promise.resolve()).then(
          () => {
            containers.set(id, { id, body, running: false });
            json(201, { Id: id });
          },
        );
        return;
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
              State: container.running ? "running" : "exited",
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
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    socket.on("error", () => {});
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    const exec = execs.get(request.url?.match(/^\/exec\/([^/]+)\//)?.[1] ?? "");
    const container = exec ? containers.get(exec.container) : undefined;
    const ended =
      (exec && container
        ? options?.onExec?.({ container, cmd: exec.cmd })
        : undefined) ??
      (exec?.cmd.join(" ").includes("command -v bun")
        ? { exitCode: 0, stdout: "/usr/local/bin/bun\n" }
        : undefined);
    if (exec && ended) exec.exitCode = ended.exitCode;
    socket.end(
      ended?.stderr
        ? dockerFrame(2, Buffer.from(ended.stderr))
        : dockerFrame(1, Buffer.from(ended?.stdout ?? "")),
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
    images,
    imageLabels,
    requests,
    /** Every exec's argv, in order. */
    commands: () => [...execs.values()].map((exec) => exec.cmd),
    close: async () => {
      // A stream whose input stayed open (an upload) ends with the daemon.
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
