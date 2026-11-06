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

/**
 * What a sandbox's Docker CLI needs so its builds use the endpoint's
 * `/build` route: BuildKit's gRPC and session endpoints carry build options
 * the endpoint cannot read, so they are not served.
 */
export const DOCKER_CLIENT_ENV: Readonly<Record<string, string>> = {
  DOCKER_BUILDKIT: "0",
  COMPOSE_BAKE: "false",
};

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

function parseJson(text: string, what: string): Json {
  try {
    const parsed: Json = JSON.parse(text);
    return parsed;
  } catch {
    throw new Refusal(400, `${what} must be JSON`);
  }
}

/** Whether a value is its type's zero value, as clients send unset fields. */
function isUnset(value: Json | undefined): boolean {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === 0 ||
    value === false
  )
    return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.values(value).every(isUnset);
  return false;
}

function notAvailable(field: string, value?: Json): Refusal {
  return new Refusal(
    403,
    value === undefined
      ? `${field} is not available in this sandbox`
      : `${field}=${JSON.stringify(value)} is not available in this sandbox`,
  );
}

/** Validates one field; throws a {@link Refusal} to refuse the request. */
type Check = (value: Json | undefined, field: string) => void | Promise<void>;

const anyValue: Check = () => {};
const unset: Check = (value, field) => {
  if (!isUnset(value)) throw notAvailable(field);
};
/** Unset, or exactly `null`: an empty list is a setting (MaskedPaths). */
const absent: Check = (value, field) => {
  if (value !== undefined && value !== null) throw notAvailable(field);
};
const oneOf =
  (...allowed: string[]): Check =>
  (value, field) => {
    if (isUnset(value)) return;
    if (typeof value !== "string" || !allowed.includes(value))
      throw notAvailable(field, value);
  };
const strings =
  (each: (value: string, field: string) => void | Promise<void>): Check =>
  async (value, field) => {
    if (isUnset(value)) return;
    if (!Array.isArray(value))
      throw new Refusal(400, `${field} must be a list`);
    for (const item of value) {
      if (typeof item !== "string")
        throw new Refusal(400, `${field} must list strings`);
      await each(item, field);
    }
  };
const fields =
  (checks: Record<string, Check>): Check =>
  async (value, field) => {
    // Every nested field is checked: an empty list can be a setting.
    if (!isObject(value)) {
      if (isUnset(value)) return;
      throw new Refusal(400, `${field} must be an object`);
    }
    await checkFields({ body: value, checks, prefix: field });
  };
const keys = (...names: string[]): Record<string, Check> =>
  Object.fromEntries(names.map((name) => [name, anyValue]));

/**
 * Check every field of a request body. A field without a check must be
 * unset, so nothing this endpoint does not know reaches the daemon with a
 * value.
 */
async function checkFields(args: {
  body: JsonObject;
  checks: Record<string, Check>;
  prefix?: string;
}): Promise<void> {
  for (const [key, value] of Object.entries(args.body)) {
    const field = args.prefix ? `${args.prefix}.${key}` : key;
    const check = Object.hasOwn(args.checks, key) ? args.checks[key] : unset;
    await (check ?? unset)(value, field);
  }
}

/** A container's resource limits: what `docker update` may change. */
const RESOURCE_CHECKS: Record<string, Check> = keys(
  "CpuShares",
  "Memory",
  "NanoCpus",
  "BlkioWeight",
  "CpuPeriod",
  "CpuQuota",
  "CpusetCpus",
  "CpusetMems",
  "MemoryReservation",
  "MemorySwap",
  "MemorySwappiness",
  "OomKillDisable",
  "PidsLimit",
  "Ulimits",
  "CpuCount",
  "CpuPercent",
  "IOMaximumIOps",
  "IOMaximumBandwidth",
  "KernelMemory",
  "KernelMemoryTCP",
  "RestartPolicy",
);

const LOG_CHECKS: Record<string, Check> = {
  Type: oneOf("json-file", "local", "none"),
  Config: fields(
    keys("max-size", "max-file", "compress", "mode", "max-buffer-size"),
  ),
};

const EXEC_CHECKS: Record<string, Check> = keys(
  "AttachStdin",
  "AttachStdout",
  "AttachStderr",
  "ConsoleSize",
  "DetachKeys",
  "Tty",
  "Env",
  "Cmd",
  "User",
  "WorkingDir",
);

const VOLUME_CREATE_CHECKS: Record<string, Check> = {
  ...keys("Name", "Labels"),
  Driver: oneOf("local"),
};

const NETWORK_CREATE_CHECKS: Record<string, Check> = {
  ...keys(
    "Name",
    "CheckDuplicate",
    "Internal",
    "Attachable",
    "EnableIPv4",
    "EnableIPv6",
    "Labels",
  ),
  Driver: oneOf("bridge"),
  Scope: oneOf("local"),
  IPAM: fields({ Driver: oneOf("default"), Config: anyValue }),
  Options: fields(
    keys(
      "com.docker.network.bridge.enable_icc",
      "com.docker.network.bridge.enable_ip_masquerade",
      "com.docker.network.bridge.host_binding_ipv4",
      "com.docker.network.driver.mtu",
    ),
  ),
};

/** Query parameters a request may carry, each with its check. */
type QueryChecks = Record<
  string,
  (value: string) => boolean | Promise<boolean>
>;
const anyParam = () => true;
const params = (...names: string[]): QueryChecks =>
  Object.fromEntries(names.map((name) => [name, anyParam]));

async function checkQuery(args: {
  url: URL;
  checks: QueryChecks;
  what: string;
}): Promise<void> {
  for (const [name, value] of args.url.searchParams) {
    const check = Object.hasOwn(args.checks, name)
      ? args.checks[name]
      : undefined;
    if (!check || !(await check(value)))
      throw new Refusal(
        403,
        `${args.what} option '${name}' is not available in this sandbox`,
      );
  }
}

const CONTAINER_ACTIONS: Record<string, readonly string[]> = {
  GET: ["json", "top", "logs", "changes", "export", "stats", "archive"],
  HEAD: ["archive"],
  PUT: ["archive"],
  POST: [
    "start",
    "stop",
    "restart",
    "kill",
    "update",
    "rename",
    "pause",
    "unpause",
    "attach",
    "wait",
    "resize",
    "exec",
  ],
  DELETE: [""],
};

const DEFAULT_NETWORKS = ["", "default", "bridge", "none"];

/**
 * A Docker Engine API endpoint for one sandbox on a trusted local-process
 * machine (ADR 0176). It forwards to the host daemon only the routes a
 * sandbox's CLI and Compose need, each checked against an allowlist of
 * fields and values; everything else is refused. It labels everything the
 * sandbox creates (only it sets the owner label), shows and touches only
 * what carries its label, and keeps the sandbox away from the host:
 * no privileged containers, added capabilities or devices, host namespaces,
 * other volume drivers, or bind mounts outside the sandbox's directory.
 * {@link removeDockerResources} deletes what is left when the sandbox goes.
 * It reduces what a trusted machine's daemon exposes; it is not a boundary
 * against a hostile workload (use microsandbox for that).
 */
export async function startDockerProxy(
  options: DockerProxyOptions,
): Promise<DockerProxy> {
  const upstream = dockerClient(options.upstreamSocket);
  const label = `${DOCKER_OWNER_LABEL}=${options.owner}`;
  const roots = options.bindRoots.map((root) => realpathOrSelf(root));

  /** The caller's labels without any owner label, plus this sandbox's. */
  const ownerLabels = (labels: Json | undefined): JsonObject =>
    Object.fromEntries([
      ...Object.entries(isObject(labels) ? labels : {}).filter(
        ([key]) =>
          key !== DOCKER_OWNER_LABEL &&
          !key.startsWith(`${DOCKER_OWNER_LABEL}.`),
      ),
      [DOCKER_OWNER_LABEL, options.owner],
    ]);

  const owned = async (
    kind: "containers" | "networks" | "volumes",
    id: string,
  ) => {
    if (!id) return false;
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
  const requireNetwork = async (name: string) => {
    if (name === "host")
      throw new Refusal(
        403,
        "The host network is not available in this sandbox",
      );
    if (!DEFAULT_NETWORKS.includes(name)) await requireOwned("networks", name);
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
        Labels: ownerLabels(undefined),
      });
      if (created.status >= 300)
        throw new Refusal(created.status, `Could not create volume ${name}`);
      return;
    }
    await requireOwned("volumes", name);
  };

  const ownedContainer = (value: string) =>
    requireOwned("containers", value.split(":")[0]?.replace(/^\//, "") ?? "");
  /** A namespace mode: one of `modes`, or another of this sandbox's containers. */
  const namespace =
    (...modes: string[]): Check =>
    async (value, field) => {
      if (isUnset(value)) return;
      if (typeof value === "string" && value.startsWith("container:"))
        return requireOwned("containers", value.slice("container:".length));
      if (typeof value !== "string" || !modes.includes(value))
        throw notAvailable(field, value);
    };
  const networkMode: Check = async (value, field) => {
    if (isUnset(value)) return;
    if (typeof value !== "string") throw notAvailable(field, value);
    if (value.startsWith("container:"))
      return requireOwned("containers", value.slice("container:".length));
    await requireNetwork(value);
  };
  const endpointChecks: Record<string, Check> = {
    ...keys(
      "IPAMConfig",
      "Aliases",
      "MacAddress",
      "NetworkID",
      "EndpointID",
      "Gateway",
      "IPAddress",
      "IPPrefixLen",
      "IPv6Gateway",
      "GlobalIPv6Address",
      "GlobalIPv6PrefixLen",
      "DNSNames",
      "GwPriority",
    ),
    Links: strings(ownedContainer),
  };
  const endpoints: Check = async (value, field) => {
    if (isUnset(value)) return;
    if (!isObject(value)) throw new Refusal(400, `${field} must be an object`);
    for (const [name, settings] of Object.entries(value)) {
      await requireNetwork(name);
      await fields(endpointChecks)(settings, `${field}.${name}`);
    }
  };
  const binds = strings(async (bind) => {
    const source = bind.split(":")[0] ?? "";
    if (source.startsWith("/")) requireBindable(source);
    else await ensureVolume(source);
  });
  const hostChecks: Record<string, Check> = {
    ...RESOURCE_CHECKS,
    ...keys(
      "ContainerIDFile",
      "PortBindings",
      "AutoRemove",
      "ConsoleSize",
      "CapDrop",
      "Dns",
      "DnsOptions",
      "DnsSearch",
      "ExtraHosts",
      "GroupAdd",
      "OomScoreAdj",
      "PublishAllPorts",
      "ReadonlyRootfs",
      "ShmSize",
      "Sysctls",
      "Tmpfs",
      "Init",
    ),
    Binds: binds,
    Mounts: anyValue, // checked and rewritten by `mount`
    LogConfig: fields(LOG_CHECKS),
    NetworkMode: networkMode,
    VolumeDriver: oneOf("local"),
    VolumesFrom: strings(ownedContainer),
    Links: strings(ownedContainer),
    CgroupnsMode: oneOf("private"),
    IpcMode: namespace("none", "private", "shareable"),
    PidMode: namespace(),
    SecurityOpt: strings((option, field) => {
      if (!/^no-new-privileges(?:[:=](?:true|false))?$/.test(option))
        throw notAvailable(field, option);
    }),
    Runtime: oneOf("runc"),
    Isolation: oneOf("default"),
    MaskedPaths: absent,
    ReadonlyPaths: absent,
  };
  const containerChecks: Record<string, Check> = {
    ...keys(
      "Hostname",
      "Domainname",
      "User",
      "AttachStdin",
      "AttachStdout",
      "AttachStderr",
      "ExposedPorts",
      "Tty",
      "OpenStdin",
      "StdinOnce",
      "Env",
      "Cmd",
      "Healthcheck",
      "ArgsEscaped",
      "Image",
      "Volumes",
      "WorkingDir",
      "Entrypoint",
      "NetworkDisabled",
      "MacAddress",
      "OnBuild",
      "Labels",
      "StopSignal",
      "StopTimeout",
      "Shell",
    ),
    HostConfig: fields(hostChecks),
    NetworkingConfig: fields({ EndpointsConfig: endpoints }),
  };

  /** Check one mount; anonymous volumes get this sandbox's label. */
  const mount = async (value: Json, field: string): Promise<Json> => {
    if (!isObject(value)) throw new Refusal(400, `${field} must be an object`);
    const base = keys("Type", "Source", "Target", "ReadOnly", "Consistency");
    const source = typeof value.Source === "string" ? value.Source : "";
    if (value.Type === "bind") {
      requireBindable(source);
      await checkFields({
        body: value,
        checks: { ...base, BindOptions: anyValue },
        prefix: field,
      });
      return value;
    }
    if (value.Type === "tmpfs") {
      await checkFields({
        body: value,
        checks: { ...base, Source: unset, TmpfsOptions: anyValue },
        prefix: field,
      });
      return value;
    }
    if (value.Type === "volume") {
      await checkFields({
        body: value,
        checks: {
          ...base,
          VolumeOptions: fields({
            ...keys("NoCopy", "Labels", "Subpath"),
            DriverConfig: fields({ Name: oneOf("local") }),
          }),
        },
        prefix: field,
      });
      if (source) {
        await ensureVolume(source);
        return value;
      }
      const volume = isObject(value.VolumeOptions) ? value.VolumeOptions : {};
      return {
        ...value,
        VolumeOptions: { ...volume, Labels: ownerLabels(volume.Labels) },
      };
    }
    throw new Refusal(
      403,
      `Mount type ${JSON.stringify(value.Type ?? null)} is not available in this sandbox`,
    );
  };

  /** Validate and label a container create body. */
  const containerCreate = async (body: JsonObject): Promise<JsonObject> => {
    await checkFields({ body, checks: containerChecks });
    const host = body.HostConfig;
    if (!isObject(host)) return { ...body, Labels: ownerLabels(body.Labels) };
    let mounts: Json | undefined = host.Mounts;
    if (Array.isArray(host.Mounts)) {
      const checked: Json[] = [];
      for (const [index, item] of host.Mounts.entries())
        checked.push(await mount(item, `HostConfig.Mounts[${index}]`));
      mounts = checked;
    } else if (!isUnset(host.Mounts))
      throw new Refusal(400, "HostConfig.Mounts must be a list");
    return {
      ...body,
      Labels: ownerLabels(body.Labels),
      HostConfig: {
        ...host,
        ...(mounts === undefined ? {} : { Mounts: mounts }),
      },
    };
  };

  const buildQuery: QueryChecks = {
    ...params(
      "dockerfile",
      "t",
      "q",
      "nocache",
      "cachefrom",
      "pull",
      "rm",
      "forcerm",
      "memory",
      "memswap",
      "cpushares",
      "cpusetcpus",
      "cpusetmems",
      "cpuperiod",
      "cpuquota",
      "buildargs",
      "shmsize",
      "squash",
      "labels",
      "platform",
      "target",
      "ulimits",
    ),
    networkmode: async (mode) => {
      await requireNetwork(mode);
      return true;
    },
    // The classic builder: BuildKit (version 2) runs through a session
    // whose build options this endpoint cannot read.
    version: (version) => version === "1",
  };

  /** Decide one request: refuse, or forward with an optional new path and body. */
  const route = async (args: {
    method: string;
    url: URL;
    body: () => Promise<JsonObject>;
  }): Promise<{ path: string; body?: JsonObject }> => {
    const { method, url } = args;
    const version = url.pathname.match(/^\/v[0-9]+(?:\.[0-9]+)?(?=\/)/)?.[0];
    const route = url.pathname.slice(version?.length ?? 0);
    const keep = () => ({ path: url.pathname + url.search });
    const filtered = () => {
      url.searchParams.set(
        "filters",
        withLabel(url.searchParams.get("filters"), label),
      );
      return keep();
    };
    const id = (raw: string) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        throw new Refusal(400, `Malformed path ${route}`);
      }
    };
    const get = method === "GET";
    const post = method === "POST";

    if (route === "/_ping" && (get || method === "HEAD")) return keep();
    if (get && (route === "/version" || route === "/info")) return keep();
    if (get && route === "/events") return filtered();
    if (post && route === "/auth") return keep();

    if (get && route === "/containers/json") return filtered();
    if (post && route === "/containers/prune") return filtered();
    if (post && route === "/containers/create") {
      await checkQuery({
        url,
        checks: params("name", "platform"),
        what: "Container",
      });
      return { ...keep(), body: await containerCreate(await args.body()) };
    }
    const container = route.match(/^\/containers\/([^/]+)(?:\/([a-z]+))?$/);
    if (container) {
      const action = container[2] ?? "";
      if (!CONTAINER_ACTIONS[method]?.includes(action))
        throw new Refusal(
          403,
          `${method} ${route} is not available in this sandbox`,
        );
      await requireOwned("containers", id(container[1] ?? ""));
      if (action === "exec" || action === "update") {
        const body = await args.body();
        await checkFields({
          body,
          checks: action === "exec" ? EXEC_CHECKS : RESOURCE_CHECKS,
        });
        return { ...keep(), body };
      }
      return keep();
    }
    const exec = route.match(/^\/exec\/([^/]+)\/(start|resize|json)$/);
    if (exec && (exec[2] === "json" ? get : post)) {
      const inspect = await upstream.json(
        "GET",
        `/exec/${encodeURIComponent(id(exec[1] ?? ""))}/json`,
      );
      const owner =
        isObject(inspect.body) && typeof inspect.body.ContainerID === "string"
          ? inspect.body.ContainerID
          : "";
      await requireOwned("containers", owner);
      return keep();
    }

    if (get && route === "/networks") return filtered();
    if (post && route === "/networks/prune") return filtered();
    if (post && route === "/networks/create") {
      const body = await args.body();
      await checkFields({ body, checks: NETWORK_CREATE_CHECKS });
      return { ...keep(), body: { ...body, Labels: ownerLabels(body.Labels) } };
    }
    const network = route.match(
      /^\/networks\/([^/]+)(?:\/(connect|disconnect))?$/,
    );
    if (network) {
      const action = network[2];
      if (action ? !post : !(get || method === "DELETE"))
        throw new Refusal(
          403,
          `${method} ${route} is not available in this sandbox`,
        );
      await requireOwned("networks", id(network[1] ?? ""));
      if (!action) return keep();
      const body = await args.body();
      await checkFields({
        body,
        checks: {
          Container: (value, field) => {
            if (typeof value !== "string")
              throw new Refusal(400, `${field} must name a container`);
            return requireOwned("containers", value);
          },
          ...(action === "connect"
            ? { EndpointConfig: fields(endpointChecks) }
            : { Force: anyValue }),
        },
      });
      return { ...keep(), body };
    }

    if (get && route === "/volumes") return filtered();
    if (post && route === "/volumes/prune") return filtered();
    if (post && route === "/volumes/create") {
      const body = await args.body();
      await checkFields({ body, checks: VOLUME_CREATE_CHECKS });
      return { ...keep(), body: { ...body, Labels: ownerLabels(body.Labels) } };
    }
    const volume = route.match(/^\/volumes\/([^/]+)$/);
    if (volume && (get || method === "DELETE")) {
      await requireOwned("volumes", id(volume[1] ?? ""));
      return keep();
    }

    // Images are a shared cache: pull, build, list, inspect and tag; never
    // delete or push.
    if (
      route.startsWith("/images/") &&
      (method === "DELETE" ||
        route === "/images/prune" ||
        route.endsWith("/push"))
    )
      throw new Refusal(
        403,
        "Images are shared on this machine; removing or pushing them is not available",
      );
    if (
      get &&
      ["/images/json", "/images/get", "/images/search"].includes(route)
    )
      return keep();
    if (post && route === "/images/load") return keep();
    if (post && route === "/images/create") {
      await checkQuery({
        url,
        checks: params("fromImage", "tag", "platform"),
        what: "Image pull",
      });
      return keep();
    }
    if (get && /^\/images\/.+\/(?:json|history|get)$/.test(route))
      return keep();
    if (post && /^\/images\/.+\/tag$/.test(route)) return keep();
    if (get && /^\/distribution\/.+\/json$/.test(route)) return keep();

    if (post && route === "/build") {
      await checkQuery({ url, checks: buildQuery, what: "Build" });
      const labels = url.searchParams.get("labels");
      if (labels !== null) {
        const parsed = parseJson(labels, "Build labels");
        const own = Object.fromEntries(
          Object.entries(isObject(parsed) ? parsed : {}).filter(
            ([key]) => key !== DOCKER_OWNER_LABEL,
          ),
        );
        url.searchParams.set("labels", JSON.stringify(own));
      }
      return keep();
    }
    if (route === "/grpc" || route === "/session")
      throw new Refusal(
        403,
        "BuildKit sessions are not available in this sandbox; builds use the classic builder (DOCKER_BUILDKIT=0)",
      );
    if (post && route === "/commit") {
      await checkQuery({
        url,
        checks: {
          ...params("repo", "tag", "comment", "author", "pause", "changes"),
          container: async (container) => {
            await requireOwned("containers", container);
            return true;
          },
        },
        what: "Commit",
      });
      if (!url.searchParams.get("container"))
        throw new Refusal(404, "No such container");
      return keep();
    }
    throw new Refusal(
      403,
      `${method} ${route} is not available in this sandbox`,
    );
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
        const parsed = parseJson(buffered.toString("utf8"), "The request body");
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
          // Docker answers some long polls (container wait) with headers
          // first; the CLI waits for them before it starts the container.
          response.flushHeaders();
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
    const parsed = parseJson(raw, "filters");
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
