import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/** Label that ties every container, network and volume to its sandbox. */
export const DOCKER_OWNER_LABEL = "work.sandbox";

export interface DockerProxyOptions {
  /** The host daemon's socket, e.g. `/var/run/docker.sock`. */
  upstreamSocket: string;
  /** The per-sandbox socket the sandbox's `DOCKER_HOST` names. */
  socketPath: string;
  /** This sandbox's id: the owner label's value. */
  owner: string;
  /** Host directories the sandbox may bind-mount: its own directory. */
  bindRoots: readonly string[];
}

export interface DockerProxy {
  readonly socketPath: string;
  close(): Promise<void>;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Docker Engine API endpoint for one sandbox on a trusted local-process
 * machine (ADR 0176). It forwards to the host daemon, labels everything the
 * sandbox creates, shows and touches only what carries its label, and
 * refuses what would reach the host: privileged containers, added
 * capabilities and devices, host namespaces, and bind mounts outside the
 * sandbox's directory. {@link removeDockerResources} deletes what is left
 * when the sandbox goes. It narrows a trusted machine's daemon; it is not a
 * boundary against a hostile workload (use microsandbox for that).
 */
export async function startDockerProxy(
  options: DockerProxyOptions,
): Promise<DockerProxy> {
  const upstream = dockerClient(options.upstreamSocket);
  const label = `${DOCKER_OWNER_LABEL}=${options.owner}`;
  const roots = options.bindRoots.map((root) => realpathOrSelf(root));

  const owned = async (
    kind: "containers" | "networks" | "volumes",
    id: string,
  ) => {
    const inspect = await upstream.json(
      "GET",
      `/${kind}/${encodeURIComponent(id)}${kind === "containers" ? "/json" : ""}`,
    );
    if (inspect.status !== 200 || !isObject(inspect.body)) return false;
    const labels =
      kind === "containers"
        ? isObject(inspect.body.Config)
          ? inspect.body.Config.Labels
          : undefined
        : inspect.body.Labels;
    return isObject(labels) && labels[DOCKER_OWNER_LABEL] === options.owner;
  };
  const requireOwned = async (
    kind: "containers" | "networks" | "volumes",
    id: string,
  ) => {
    if (!(await owned(kind, id)))
      throw new Refusal(404, `No such ${kind.slice(0, -1)}: ${id}`);
  };
  const requireBindable = (source: string) => {
    const resolved = realpathOrSelf(path.resolve(source));
    if (
      !roots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      )
    )
      throw new Refusal(
        403,
        `Bind mounts are limited to this sandbox's directory; '${source}' is outside it`,
      );
  };
  const ensureVolume = async (name: string) => {
    const inspect = await upstream.json(
      "GET",
      `/volumes/${encodeURIComponent(name)}`,
    );
    if (inspect.status === 404) {
      const created = await upstream.json("POST", "/volumes/create", {
        Name: name,
        Labels: { [DOCKER_OWNER_LABEL]: options.owner },
      });
      if (created.status >= 300)
        throw new Refusal(created.status, `Could not create volume ${name}`);
      return;
    }
    await requireOwned("volumes", name);
  };

  /** Validate and label a container create body. */
  const containerCreate = async (body: JsonObject): Promise<JsonObject> => {
    const host = isObject(body.HostConfig) ? body.HostConfig : {};
    if (host.Privileged === true)
      throw new Refusal(
        403,
        "Privileged containers are not available in this sandbox",
      );
    for (const key of [
      "CapAdd",
      "Devices",
      "DeviceRequests",
      "DeviceCgroupRules",
    ]) {
      const value = host[key];
      if (Array.isArray(value) && value.length > 0)
        throw new Refusal(403, `${key} is not available in this sandbox`);
    }
    for (const key of [
      "PidMode",
      "IpcMode",
      "UTSMode",
      "UsernsMode",
      "CgroupnsMode",
    ]) {
      if (host[key] === "host")
        throw new Refusal(403, `${key}=host is not available in this sandbox`);
    }
    if (typeof host.CgroupParent === "string" && host.CgroupParent)
      throw new Refusal(403, "CgroupParent is not available in this sandbox");
    const security = host.SecurityOpt;
    if (
      Array.isArray(security) &&
      security.some(
        (option) => typeof option === "string" && /unconfined/.test(option),
      )
    )
      throw new Refusal(
        403,
        "Unconfined security options are not available in this sandbox",
      );
    const network = host.NetworkMode;
    if (network === "host")
      throw new Refusal(
        403,
        "The host network is not available in this sandbox",
      );
    if (typeof network === "string" && network.startsWith("container:"))
      await requireOwned("containers", network.slice("container:".length));
    else if (
      typeof network === "string" &&
      !["", "default", "bridge", "none"].includes(network)
    )
      await requireOwned("networks", network);
    const endpoints =
      isObject(body.NetworkingConfig) &&
      isObject(body.NetworkingConfig.EndpointsConfig)
        ? Object.keys(body.NetworkingConfig.EndpointsConfig)
        : [];
    for (const name of endpoints)
      if (!["bridge", "default"].includes(name))
        await requireOwned("networks", name);
    for (const bind of Array.isArray(host.Binds) ? host.Binds : []) {
      if (typeof bind !== "string") continue;
      const source = bind.split(":")[0] ?? "";
      if (source.startsWith("/")) requireBindable(source);
      else await ensureVolume(source);
    }
    for (const mount of Array.isArray(host.Mounts) ? host.Mounts : []) {
      if (!isObject(mount)) continue;
      const source = typeof mount.Source === "string" ? mount.Source : "";
      if (mount.Type === "bind") requireBindable(source);
      else if (mount.Type === "volume") {
        if (source) await ensureVolume(source);
      } else if (mount.Type !== "tmpfs")
        throw new Refusal(
          403,
          `Mount type ${String(mount.Type)} is not available in this sandbox`,
        );
    }
    for (const from of Array.isArray(host.VolumesFrom) ? host.VolumesFrom : [])
      if (typeof from === "string")
        await requireOwned("containers", from.split(":")[0] ?? "");
    const labels = isObject(body.Labels) ? body.Labels : {};
    return {
      ...body,
      Labels: { ...labels, [DOCKER_OWNER_LABEL]: options.owner },
    };
  };

  /** Decide one request: refuse, or forward with an optional new path and body. */
  const route = async (args: {
    method: string;
    url: URL;
    body: () => Promise<JsonObject>;
  }): Promise<{ path: string; body?: JsonObject }> => {
    const { method, url } = args;
    const version = url.pathname.match(/^\/v[0-9.]+(?=\/)/)?.[0] ?? "";
    const route = url.pathname.slice(version.length);
    const segments = route.split("/").filter(Boolean).map(decodeURIComponent);
    const [kind, id, action] = segments;
    const keep = () => ({ path: url.pathname + url.search });
    const filtered = () => {
      url.searchParams.set(
        "filters",
        withLabel(url.searchParams.get("filters"), label),
      );
      return keep();
    };
    if (route === "/_ping" || route === "/version" || route === "/info")
      return keep();
    if (route === "/events" && method === "GET") return filtered();
    if (kind === "containers") {
      if (id === "json" && method === "GET") return filtered();
      if (id === "prune" && method === "POST") return filtered();
      if (id === "create" && method === "POST")
        return { ...keep(), body: await containerCreate(await args.body()) };
      if (!id) throw new Refusal(403, "Not available in this sandbox");
      await requireOwned("containers", id);
      if (action === "exec" && method === "POST") {
        const body = await args.body();
        if (body.Privileged === true)
          throw new Refusal(
            403,
            "Privileged exec is not available in this sandbox",
          );
        return { ...keep(), body };
      }
      return keep();
    }
    if (kind === "exec" && id) {
      const inspect = await upstream.json(
        "GET",
        `/exec/${encodeURIComponent(id)}/json`,
      );
      const container =
        isObject(inspect.body) && typeof inspect.body.ContainerID === "string"
          ? inspect.body.ContainerID
          : "";
      await requireOwned("containers", container);
      return keep();
    }
    if (kind === "networks") {
      if (!id && method === "GET") return filtered();
      if (id === "prune" && method === "POST") return filtered();
      if (id === "create" && method === "POST") {
        const body = await args.body();
        const driver = body.Driver;
        if (driver !== undefined && driver !== "" && driver !== "bridge")
          throw new Refusal(
            403,
            "Only bridge networks are available in this sandbox",
          );
        const labels = isObject(body.Labels) ? body.Labels : {};
        return {
          ...keep(),
          body: {
            ...body,
            Labels: { ...labels, [DOCKER_OWNER_LABEL]: options.owner },
          },
        };
      }
      if (!id) throw new Refusal(403, "Not available in this sandbox");
      await requireOwned("networks", id);
      if (
        (action === "connect" || action === "disconnect") &&
        method === "POST"
      ) {
        const body = await args.body();
        if (typeof body.Container === "string")
          await requireOwned("containers", body.Container);
        return { ...keep(), body };
      }
      return keep();
    }
    if (kind === "volumes") {
      if (!id && method === "GET") return filtered();
      if (id === "prune" && method === "POST") return filtered();
      if (id === "create" && method === "POST") {
        const body = await args.body();
        if (
          isObject(body.DriverOpts) &&
          Object.keys(body.DriverOpts).length > 0
        )
          throw new Refusal(
            403,
            "Volume driver options are not available in this sandbox",
          );
        const labels = isObject(body.Labels) ? body.Labels : {};
        return {
          ...keep(),
          body: {
            ...body,
            Labels: { ...labels, [DOCKER_OWNER_LABEL]: options.owner },
          },
        };
      }
      if (!id) throw new Refusal(403, "Not available in this sandbox");
      await requireOwned("volumes", id);
      return keep();
    }
    // Images are a shared cache: pull, list, inspect and tag, never delete or push.
    if (kind === "images") {
      if (method === "DELETE" || action === "push" || id === "prune")
        throw new Refusal(
          403,
          "Images are shared on this machine; removing or pushing them is not available",
        );
      return keep();
    }
    if (kind === "build" && method === "POST") {
      const mode = url.searchParams.get("networkmode");
      if (mode === "host")
        throw new Refusal(
          403,
          "Builds cannot use the host network in this sandbox",
        );
      return keep();
    }
    if (kind === "commit" && method === "POST") {
      await requireOwned("containers", url.searchParams.get("container") ?? "");
      return keep();
    }
    if (kind === "session" || kind === "distribution" || kind === "auth")
      return keep();
    throw new Refusal(403, `${route} is not available in this sandbox`);
  };

  const refuse = (response: http.ServerResponse, error: unknown) => {
    const status = error instanceof Refusal ? error.status : 502;
    const message =
      error instanceof Error ? error.message : "Docker proxy error";
    if (!response.headersSent)
      response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ message }));
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://docker");
      let buffered: Buffer | undefined;
      const readBody = async (): Promise<JsonObject> => {
        buffered ??= await readAll(request);
        if (buffered.length === 0) return {};
        const parsed: Json = JSON.parse(buffered.toString("utf8"));
        if (!isObject(parsed)) throw new Refusal(400, "Expected a JSON object");
        return parsed;
      };
      const decision = await route({
        method: request.method ?? "GET",
        url,
        body: readBody,
      });
      const headers = { ...request.headers };
      const body =
        decision.body !== undefined
          ? Buffer.from(JSON.stringify(decision.body))
          : buffered;
      if (body !== undefined) {
        headers["content-length"] = String(body.length);
        delete headers["transfer-encoding"];
      }
      const forwarded = http.request(
        {
          socketPath: options.upstreamSocket,
          method: request.method,
          path: decision.path,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        },
      );
      forwarded.on("error", (error) => refuse(response, error));
      if (body !== undefined) forwarded.end(body);
      else request.pipe(forwarded);
    })().catch((error: unknown) => refuse(response, error));
  });

  // Attach and exec start hijack the connection for raw streams.
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://docker");
      const decision = await route({
        method: request.method ?? "POST",
        url,
        body: async () => {
          throw new Refusal(400, "Upgrade requests carry no body here");
        },
      });
      const target = net.createConnection(options.upstreamSocket);
      target.on("error", () => socket.destroy());
      socket.on("error", () => target.destroy());
      const lines = [`${request.method} ${decision.path} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        lines.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
        );
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    })().catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Docker proxy error";
      const status = error instanceof Refusal ? error.status : 502;
      const body = JSON.stringify({ message });
      socket.end(
        `HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  });

  fs.mkdirSync(path.dirname(options.socketPath), { recursive: true });
  fs.rmSync(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  fs.chmodSync(options.socketPath, 0o600);
  return {
    socketPath: options.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
        fs.rmSync(options.socketPath, { force: true });
      }),
  };
}

/**
 * Delete every container (with its anonymous volumes), network and volume
 * that carries this sandbox's label.
 */
export async function removeDockerResources(args: {
  upstreamSocket: string;
  owner: string;
}): Promise<{ containers: number; networks: number; volumes: number }> {
  const upstream = dockerClient(args.upstreamSocket);
  const filters = encodeURIComponent(
    withLabel(null, `${DOCKER_OWNER_LABEL}=${args.owner}`),
  );
  const ids = async (listPath: string, key: string, field: string) => {
    const listed = await upstream.json("GET", listPath);
    if (listed.status !== 200)
      throw new Error(`Docker answered ${listed.status} listing ${listPath}`);
    const items = isObject(listed.body) ? listed.body[key] : listed.body;
    return (Array.isArray(items) ? items : []).flatMap((item) =>
      isObject(item) && typeof item[field] === "string"
        ? [String(item[field])]
        : [],
    );
  };
  const remove = async (target: string) => {
    const removed = await upstream.json("DELETE", target);
    if (removed.status >= 300 && removed.status !== 404)
      throw new Error(`Docker answered ${removed.status} removing ${target}`);
  };
  const containers = await ids(
    `/containers/json?all=1&filters=${filters}`,
    "",
    "Id",
  );
  for (const id of containers) await remove(`/containers/${id}?force=1&v=1`);
  const networks = await ids(`/networks?filters=${filters}`, "", "Id");
  for (const id of networks) await remove(`/networks/${id}`);
  const volumes = await ids(`/volumes?filters=${filters}`, "Volumes", "Name");
  for (const name of volumes)
    await remove(`/volumes/${encodeURIComponent(name)}`);
  return {
    containers: containers.length,
    networks: networks.length,
    volumes: volumes.length,
  };
}

/** Whether a Docker daemon answers on this socket. */
export async function dockerAvailable(socketPath: string): Promise<boolean> {
  try {
    return (
      (await dockerClient(socketPath).json("GET", "/_ping")).status === 200
    );
  } catch {
    return false;
  }
}

function dockerClient(socketPath: string) {
  return {
    json: (
      method: string,
      requestPath: string,
      body?: Json,
    ): Promise<{ status: number; body: Json | undefined }> =>
      new Promise((resolve, reject) => {
        const payload =
          body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const request = http.request(
          {
            socketPath,
            method,
            path: requestPath,
            headers: payload
              ? {
                  "content-type": "application/json",
                  "content-length": payload.length,
                }
              : {},
          },
          (response) => {
            readAll(response)
              .then((raw) => {
                const text = raw.toString("utf8");
                let parsed: Json | undefined;
                try {
                  parsed = text ? JSON.parse(text) : undefined;
                } catch {
                  parsed = text;
                }
                resolve({ status: response.statusCode ?? 502, body: parsed });
              })
              .catch(reject);
          },
        );
        request.on("error", reject);
        request.end(payload);
      }),
  };
}

/**
 * Add the owner label to a Docker `filters` query value, in the daemon's
 * canonical `{ name: { value: true } }` form (current daemons refuse the
 * old array form).
 */
export function withLabel(raw: string | null, label: string): string {
  let filters: JsonObject = {};
  if (raw) {
    const parsed: Json = JSON.parse(raw);
    if (isObject(parsed)) filters = parsed;
  }
  const existing = filters.label;
  const labels = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : isObject(existing)
      ? Object.keys(existing)
      : [];
  return JSON.stringify(
    canonicalFilters({ ...filters, label: [...labels, label] }),
  );
}

function canonicalFilters(filters: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(filters).map(([name, value]) => [
      name,
      Array.isArray(value)
        ? Object.fromEntries(value.map((item) => [String(item), true]))
        : value,
    ]),
  );
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}
