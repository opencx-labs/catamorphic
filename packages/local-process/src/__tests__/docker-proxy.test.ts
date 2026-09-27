import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOCKER_OWNER_LABEL,
  type DockerProxy,
  dockerAvailable,
  removeDockerResources,
  startDockerProxy,
  withLabel,
} from "../docker-proxy.js";
import { LocalProcessSandboxProvider } from "../sandbox-provider.js";

type Labels = Record<string, string>;
interface FakeResource {
  id: string;
  labels: Labels;
  body?: unknown;
}

/** An in-memory Docker Engine API, enough to exercise the proxy. */
function fakeDocker(socketPath: string) {
  const containers = new Map<string, FakeResource>();
  const networks = new Map<string, FakeResource>();
  const volumes = new Map<string, FakeResource>();
  const requests: string[] = [];
  const queries: URLSearchParams[] = [];
  let next = 0;
  const matches = (labels: Labels, filters: string | null) => {
    if (!filters) return true;
    const parsed: { label?: Record<string, boolean> } = JSON.parse(filters);
    return Object.keys(parsed.label ?? {}).every((entry) => {
      const [key, value] = entry.split("=");
      return key !== undefined && labels[key] === value;
    });
  };
  const read = (request: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
    });
  const labelsOf = (body: Record<string, unknown>): Labels => {
    const labels = body.Labels;
    return typeof labels === "object" && labels !== null
      ? Object.fromEntries(
          Object.entries(labels).map(([key, value]) => [key, String(value)]),
        )
      : {};
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://docker");
    const route = url.pathname.replace(/^\/v[0-9.]+/, "");
    requests.push(`${request.method} ${route}`);
    queries.push(url.searchParams);
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    const filters = url.searchParams.get("filters");
    const [, kind, id, action] = route.split("/");
    if (route === "/_ping") return send(200, "OK");
    if (kind === "containers") {
      if (id === "json")
        return send(
          200,
          [...containers.values()]
            .filter((item) => matches(item.labels, filters))
            .map((item) => ({ Id: item.id, Labels: item.labels })),
        );
      if (id === "create") {
        const body = await read(request);
        const created = { id: `c${++next}`, labels: labelsOf(body), body };
        containers.set(created.id, created);
        return send(201, { Id: created.id });
      }
      const item = id ? containers.get(id) : undefined;
      if (!item) return send(404, { message: "No such container" });
      if (action === "json")
        return send(200, { Id: item.id, Config: { Labels: item.labels } });
      if (request.method === "DELETE") {
        containers.delete(item.id);
        return send(204);
      }
      return send(204);
    }
    if (kind === "networks") {
      if (!id)
        return send(
          200,
          [...networks.values()]
            .filter((item) => matches(item.labels, filters))
            .map((item) => ({ Id: item.id, Labels: item.labels })),
        );
      if (id === "create") {
        const body = await read(request);
        const created = { id: `n${++next}`, labels: labelsOf(body) };
        networks.set(created.id, created);
        return send(201, { Id: created.id });
      }
      const item = networks.get(id);
      if (!item) return send(404, { message: "No such network" });
      if (request.method === "DELETE") {
        networks.delete(item.id);
        return send(204);
      }
      return send(200, { Id: item.id, Labels: item.labels });
    }
    if (kind === "volumes") {
      if (!id)
        return send(200, {
          Volumes: [...volumes.values()]
            .filter((item) => matches(item.labels, filters))
            .map((item) => ({ Name: item.id, Labels: item.labels })),
        });
      if (id === "create") {
        const body = await read(request);
        const created = { id: String(body.Name), labels: labelsOf(body) };
        volumes.set(created.id, created);
        return send(201, { Name: created.id });
      }
      const item = volumes.get(id);
      if (!item) return send(404, { message: "No such volume" });
      if (request.method === "DELETE") {
        volumes.delete(item.id);
        return send(204);
      }
      return send(200, { Name: item.id, Labels: item.labels });
    }
    return send(404, { message: `unhandled ${route}` });
  });
  return {
    containers,
    networks,
    volumes,
    requests,
    queries,
    listen: () =>
      new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function call(args: {
  socketPath: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload =
      args.body === undefined ? undefined : JSON.stringify(args.body);
    const request = http.request(
      {
        socketPath: args.socketPath,
        method: args.method,
        path: args.path,
        headers: payload ? { "content-type": "application/json" } : {},
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("Docker proxy (ADR 0176)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wdp-"));
  const upstreamSocket = path.join(dir, "up.sock");
  const socketPath = path.join(dir, "sb.sock");
  const sandboxDir = path.join(dir, "sandbox");
  const docker = fakeDocker(upstreamSocket);
  let proxy: DockerProxy;

  beforeAll(async () => {
    fs.mkdirSync(path.join(sandboxDir, "workspace"), { recursive: true });
    await docker.listen();
    docker.containers.set("foreign", {
      id: "foreign",
      labels: { [DOCKER_OWNER_LABEL]: "someone-else" },
    });
    proxy = await startDockerProxy({
      upstreamSocket,
      socketPath,
      owner: "sb-1",
      bindRoots: [sandboxDir],
    });
  });
  afterAll(async () => {
    await proxy.close();
    await docker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("labels what the sandbox creates and lists only its own", async () => {
    const created = await call({
      socketPath,
      method: "POST",
      path: "/v1.47/containers/create",
      body: {
        Image: "alpine",
        HostConfig: {
          Binds: [`${sandboxDir}/workspace:/app`, "cache:/cache"],
        },
      },
    });
    expect(created.status).toBe(201);
    const id = String(Reflect.get(Object(created.body), "Id"));
    expect(docker.containers.get(id)?.labels[DOCKER_OWNER_LABEL]).toBe("sb-1");
    // A named volume is created, labelled, before the container uses it.
    expect(docker.volumes.get("cache")?.labels[DOCKER_OWNER_LABEL]).toBe(
      "sb-1",
    );
    const listed = await call({
      socketPath,
      method: "GET",
      path: "/v1.47/containers/json?all=1",
    });
    expect(listed.body).toEqual([
      { Id: id, Labels: { [DOCKER_OWNER_LABEL]: "sb-1" } },
    ]);
    expect(
      (
        await call({
          socketPath,
          method: "POST",
          path: `/v1.47/containers/${id}/start`,
        })
      ).status,
    ).toBe(204);
  });

  it("hides other sandboxes' containers", async () => {
    const started = await call({
      socketPath,
      method: "POST",
      path: "/v1.47/containers/foreign/start",
    });
    expect(started.status).toBe(404);
    const removed = await call({
      socketPath,
      method: "DELETE",
      path: "/containers/foreign?force=1",
    });
    expect(removed.status).toBe(404);
    expect(docker.containers.has("foreign")).toBe(true);
  });

  it.each([
    [{ Privileged: true }, "Privileged"],
    [{ NetworkMode: "host" }, "host network"],
    [{ PidMode: "host" }, "PidMode"],
    [{ CapAdd: ["SYS_ADMIN"] }, "CapAdd"],
    [{ Devices: [{ PathOnHost: "/dev/kvm" }] }, "Devices"],
    [{ Binds: ["/etc:/host-etc"] }, "outside"],
    [{ Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] }, "outside"],
    [{ SecurityOpt: ["seccomp=unconfined"] }, "SecurityOpt"],
  ])("refuses %j", async (hostConfig, message) => {
    const refused = await call({
      socketPath,
      method: "POST",
      path: "/containers/create",
      body: { Image: "alpine", HostConfig: hostConfig },
    });
    expect(refused.status).toBe(403);
    expect(String(Reflect.get(Object(refused.body), "message"))).toContain(
      message,
    );
  });

  it("refuses endpoints outside containers, networks, volumes and images", async () => {
    for (const target of ["/swarm/init", "/plugins", "/system/df"]) {
      const refused = await call({
        socketPath,
        method: target === "/swarm/init" ? "POST" : "GET",
        path: target,
      });
      expect(refused.status).toBe(403);
    }
  });

  it("removes the sandbox's containers, networks and volumes, and nothing else", async () => {
    await call({
      socketPath,
      method: "POST",
      path: "/networks/create",
      body: { Name: "app" },
    });
    const refusedDriver = await call({
      socketPath,
      method: "POST",
      path: "/networks/create",
      body: { Name: "lan", Driver: "macvlan" },
    });
    expect(refusedDriver.status).toBe(403);
    const removed = await removeDockerResources({
      upstreamSocket,
      owner: "sb-1",
    });
    expect(removed).toEqual({ containers: 1, networks: 1, volumes: 1 });
    expect([...docker.containers.keys()]).toEqual(["foreign"]);
    expect(docker.networks.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  it("adds the owner label to existing filters", () => {
    expect(
      JSON.parse(
        withLabel(
          JSON.stringify({ label: { "com.docker.compose.project=x": true } }),
          "work.sandbox=a",
        ),
      ),
    ).toEqual({
      label: { "com.docker.compose.project=x": true, "work.sandbox=a": true },
    });
  });
});

describe("Docker proxy allowlist (ADR 0176)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wda-"));
  const upstreamSocket = path.join(dir, "up.sock");
  const socketPath = path.join(dir, "sb.sock");
  const sandboxDir = path.join(dir, "sandbox");
  const docker = fakeDocker(upstreamSocket);
  let proxy: DockerProxy;
  const owner = { [DOCKER_OWNER_LABEL]: "sb-2" };

  beforeAll(async () => {
    fs.mkdirSync(path.join(sandboxDir, "workspace"), { recursive: true });
    await docker.listen();
    docker.containers.set("mine", { id: "mine", labels: owner });
    docker.containers.set("theirs", {
      id: "theirs",
      labels: { [DOCKER_OWNER_LABEL]: "sb-other" },
    });
    proxy = await startDockerProxy({
      upstreamSocket,
      socketPath,
      owner: "sb-2",
      bindRoots: [sandboxDir],
    });
  });
  afterAll(async () => {
    await proxy.close();
    await docker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const message = (body: unknown) =>
    String(Reflect.get(Object(body), "message"));

  it("accepts what the Docker CLI and Compose send", async () => {
    // Recorded from `docker compose up` (Docker 29): every field present,
    // most at their zero value.
    const created = await call({
      socketPath,
      method: "POST",
      path: "/v1.55/containers/create?name=app-web-1",
      body: {
        Hostname: "",
        User: "",
        AttachStdout: true,
        ExposedPorts: { "80/tcp": {} },
        Env: null,
        Cmd: ["sleep", "30"],
        Image: "app-web",
        Volumes: null,
        Entrypoint: null,
        Labels: { "com.docker.compose.project": "app" },
        HostConfig: {
          Binds: ["app_data:/data:rw", `${sandboxDir}/workspace:/src:rw`],
          ContainerIDFile: "",
          LogConfig: { Type: "", Config: null },
          NetworkMode: "bridge",
          PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "18080" }] },
          RestartPolicy: { Name: "", MaximumRetryCount: 0 },
          AutoRemove: false,
          VolumeDriver: "",
          VolumesFrom: null,
          ConsoleSize: [0, 0],
          CapAdd: null,
          CapDrop: null,
          CgroupnsMode: "",
          DnsOptions: [],
          ExtraHosts: [],
          IpcMode: "",
          Cgroup: "",
          Links: null,
          OomScoreAdj: 0,
          PidMode: "",
          Privileged: false,
          SecurityOpt: null,
          UTSMode: "",
          UsernsMode: "",
          Isolation: "",
          CgroupParent: "",
          BlkioWeightDevice: [],
          CpuRealtimePeriod: 0,
          Devices: [],
          DeviceCgroupRules: null,
          DeviceRequests: null,
          MemorySwappiness: -1,
          PidsLimit: 0,
          Ulimits: [],
          MaskedPaths: null,
          ReadonlyPaths: null,
        },
        NetworkingConfig: {
          EndpointsConfig: {
            bridge: {
              IPAMConfig: null,
              Links: null,
              Aliases: ["web"],
              DriverOpts: null,
              GwPriority: 0,
              IPAddress: "",
              DNSNames: null,
            },
          },
        },
      },
    });
    expect(created.status, message(created.body)).toBe(201);
  });

  it.each([
    [{ MaskedPaths: [] }, "MaskedPaths"],
    [{ ReadonlyPaths: [] }, "ReadonlyPaths"],
    [{ CgroupParent: "/" }, "CgroupParent"],
    [{ IpcMode: "host" }, "IpcMode"],
    [{ UTSMode: "host" }, "UTSMode"],
    [{ UsernsMode: "host" }, "UsernsMode"],
    [{ CgroupnsMode: "host" }, "CgroupnsMode"],
    [{ Runtime: "nvidia" }, "Runtime"],
    [{ Annotations: { "io.kubernetes.cri": "x" } }, "Annotations"],
    [{ LogConfig: { Type: "syslog" } }, "LogConfig.Type"],
    [
      { LogConfig: { Type: "json-file", Config: { "syslog-address": "x" } } },
      "syslog-address",
    ],
    [{ SecurityOpt: ["apparmor=unconfined"] }, "SecurityOpt"],
    [{ SecurityOpt: ["label=disable"] }, "SecurityOpt"],
    [{ VolumeDriver: "nfs" }, "VolumeDriver"],
    [{ DeviceCgroupRules: ["a *:* rwm"] }, "DeviceCgroupRules"],
    [{ BlkioDeviceReadBps: [{ Path: "/dev/sda", Rate: 1 }] }, "Blkio"],
    [{ StorageOpt: { size: "1G" } }, "StorageOpt"],
    [{ SomethingNew: true }, "SomethingNew"],
    [
      {
        Mounts: [
          {
            Type: "volume",
            Target: "/host",
            VolumeOptions: {
              DriverConfig: {
                Name: "local",
                Options: { type: "none", o: "bind", device: "/" },
              },
            },
          },
        ],
      },
      "DriverConfig.Options",
    ],
    [{ Mounts: [{ Type: "npipe", Target: "/x" }] }, "Mount type"],
  ])("refuses HostConfig %j", async (hostConfig, expected) => {
    const refused = await call({
      socketPath,
      method: "POST",
      path: "/containers/create",
      body: { Image: "alpine", HostConfig: hostConfig },
    });
    expect(refused.status).toBe(403);
    expect(message(refused.body)).toContain(expected);
  });

  it("refuses unknown container fields and other sandboxes' containers", async () => {
    const unknown = await call({
      socketPath,
      method: "POST",
      path: "/containers/create",
      body: { Image: "alpine", Future: { enabled: true } },
    });
    expect(unknown.status).toBe(403);
    for (const hostConfig of [
      { Links: ["theirs:db"] },
      { VolumesFrom: ["theirs"] },
      { PidMode: "container:theirs" },
      { NetworkMode: "container:theirs" },
    ]) {
      const refused = await call({
        socketPath,
        method: "POST",
        path: "/containers/create",
        body: { Image: "alpine", HostConfig: hostConfig },
      });
      expect(refused.status, JSON.stringify(hostConfig)).toBe(404);
    }
    const shared = await call({
      socketPath,
      method: "POST",
      path: "/containers/create",
      body: { Image: "alpine", HostConfig: { PidMode: "container:mine" } },
    });
    expect(shared.status).toBe(201);
  });

  it("only this endpoint sets the owner label", async () => {
    const forged = { [DOCKER_OWNER_LABEL]: "sb-other", keep: "yes" };
    const container = await call({
      socketPath,
      method: "POST",
      path: "/containers/create",
      body: {
        Image: "alpine",
        Labels: forged,
        HostConfig: {
          Mounts: [
            {
              Type: "volume",
              Target: "/anon",
              VolumeOptions: { Labels: forged },
            },
          ],
        },
      },
    });
    expect(container.status).toBe(201);
    const stored = docker.containers.get(
      String(Reflect.get(Object(container.body), "Id")),
    );
    expect(stored?.labels).toEqual({ ...owner, keep: "yes" });
    const mount = Reflect.get(
      Object(Reflect.get(Object(stored?.body), "HostConfig")),
      "Mounts",
    );
    expect(mount).toEqual([
      {
        Type: "volume",
        Target: "/anon",
        VolumeOptions: { Labels: { keep: "yes", ...owner } },
      },
    ]);
    await call({
      socketPath,
      method: "POST",
      path: "/networks/create",
      body: { Name: "forged-net", Labels: forged },
    });
    await call({
      socketPath,
      method: "POST",
      path: "/volumes/create",
      body: { Name: "forged-vol", Labels: forged },
    });
    for (const item of [
      ...docker.networks.values(),
      ...docker.volumes.values(),
    ])
      expect(item.labels[DOCKER_OWNER_LABEL]).toBe("sb-2");
  });

  it.each([
    [{ Name: "v", Driver: "nfs" }, "Driver"],
    [{ Name: "v", DriverOpts: { device: "/" } }, "DriverOpts"],
    [{ Name: "v", ClusterVolumeSpec: { Group: "g" } }, "ClusterVolumeSpec"],
  ])("refuses volume %j", async (body, expected) => {
    const refused = await call({
      socketPath,
      method: "POST",
      path: "/volumes/create",
      body,
    });
    expect(refused.status).toBe(403);
    expect(message(refused.body)).toContain(expected);
  });

  it.each([
    [{ Name: "n", Driver: "macvlan" }, "Driver"],
    [
      { Name: "n", Options: { "com.docker.network.bridge.name": "docker0" } },
      "bridge.name",
    ],
    [{ Name: "n", IPAM: { Driver: "dhcp" } }, "IPAM.Driver"],
    [{ Name: "n", ConfigFrom: { Network: "x" } }, "ConfigFrom"],
    [{ Name: "n", Ingress: true }, "Ingress"],
  ])("refuses network %j", async (body, expected) => {
    const refused = await call({
      socketPath,
      method: "POST",
      path: "/networks/create",
      body,
    });
    expect(refused.status).toBe(403);
    expect(message(refused.body)).toContain(expected);
  });

  it("checks exec and update bodies", async () => {
    const cases: [string, Record<string, unknown>, number][] = [
      ["exec", { Cmd: ["id"], AttachStdout: true, Privileged: false }, 204],
      ["exec", { Cmd: ["id"], Privileged: true }, 403],
      ["update", { Memory: 1024, RestartPolicy: { Name: "always" } }, 204],
      ["update", { Devices: [{ PathOnHost: "/dev/kvm" }] }, 403],
      ["update", { CgroupParent: "/" }, 403],
    ];
    for (const [action, body, status] of cases) {
      const response = await call({
        socketPath,
        method: "POST",
        path: `/v1.55/containers/mine/${action}`,
        body,
      });
      expect(response.status, `${action} ${JSON.stringify(body)}`).toBe(status);
    }
  });

  it("strips the owner label from builds", async () => {
    docker.requests.length = 0;
    const built = await call({
      socketPath,
      method: "POST",
      path: `/v1.55/build?t=x&version=1&labels=${encodeURIComponent(
        JSON.stringify({ [DOCKER_OWNER_LABEL]: "sb-other", keep: "yes" }),
      )}`,
    });
    expect(built.status).toBe(404); // forwarded: the fake has no builder
    expect(docker.queries.at(-1)?.get("labels")).toBe(
      JSON.stringify({ keep: "yes" }),
    );
  });

  it.each([
    ["HEAD", "/_ping"],
    ["GET", "/v1.55/version"],
    ["GET", "/info"],
    ["GET", "/events"],
    ["POST", "/auth"],
    ["GET", "/images/json"],
    ["POST", "/images/create?fromImage=alpine&tag=latest"],
    ["GET", "/v1.55/images/ghcr.io/owner/app:1/json"],
    ["POST", "/images/alpine/tag?repo=mine&tag=1"],
    ["POST", "/images/load"],
    ["GET", "/distribution/docker.io/library/alpine/json"],
    ["POST", "/build?t=x&dockerfile=Dockerfile&version=1&networkmode=none"],
    ["GET", "/containers/mine/logs?follow=1"],
    ["PUT", "/containers/mine/archive?path=/tmp"],
    ["POST", "/containers/mine/attach?stream=1"],
    ["POST", "/commit?container=mine&repo=snap"],
    ["DELETE", "/containers/mine?force=1"],
  ])("forwards %s %s", async (method, target) => {
    docker.requests.length = 0;
    const response = await call({ socketPath, method, path: target });
    expect(response.status, message(response.body)).not.toBe(403);
    const route = new URL(target, "http://docker").pathname.replace(
      /^\/v[0-9.]+/,
      "",
    );
    expect(docker.requests).toContain(`${method} ${route}`);
  });

  it.each([
    ["POST", "/images/create?fromSrc=http://169.254.169.254/"],
    ["DELETE", "/images/alpine"],
    ["POST", "/images/alpine/push"],
    ["POST", "/images/prune"],
    ["POST", "/build?networkmode=host"],
    ["POST", "/build?extrahosts=db:10.0.0.1"],
    ["POST", "/build?remote=https://example.com/context.tar"],
    ["POST", "/build?cgroupparent=/"],
    ["POST", "/build?version=2&session=x"],
    ["POST", "/build/prune"],
    ["POST", "/grpc"],
    ["POST", "/session"],
    ["GET", "/system/df"],
    ["POST", "/swarm/init"],
    ["GET", "/plugins"],
    ["GET", "/secrets"],
    ["POST", "/v1.47/../swarm/init"],
    ["GET", "//containers/json"],
    ["POST", "/containers/mine/copy"],
    ["GET", "/containers/mine/attach/ws"],
    ["PUT", "/volumes/app_data"],
    ["POST", "/containers/json"],
  ])("refuses %s %s", async (method, target) => {
    docker.requests.length = 0;
    const response = await call({ socketPath, method, path: target });
    expect(response.status).toBe(403);
    expect(message(response.body)).toContain("not available");
  });
});

const hostSocket = process.env.WORK_TEST_DOCKER_SOCKET;
const run = promisify(execFile);

// Real Docker: WORK_TEST_DOCKER_SOCKET=/var/run/docker.sock (or the Docker
// Desktop socket). Pulls alpine; removes everything it starts.
describe.skipIf(!hostSocket)("local-process containers on real Docker", () => {
  it("runs docker compose in a sandbox and removes everything with it", async () => {
    const socket = hostSocket ?? "";
    expect(await dockerAvailable(socket)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wlp-"));
    const provider = new LocalProcessSandboxProvider({
      root,
      docker: {
        socketPath: socket,
        cliPlugins: path.join(os.homedir(), ".docker", "cli-plugins"),
      },
    });
    const sandbox = await provider.createSandbox({ containers: true });
    try {
      await provider.uploadFiles(
        sandbox.id,
        {
          "compose.yml":
            "services:\n  web:\n    build: .\n    command: sleep 300\n    volumes:\n      - data:/data\n      - ./:/src\nvolumes:\n  data: {}\n",
          // Builds reach the daemon through the endpoint's checked /build.
          Dockerfile: "FROM alpine\nRUN echo built > /built\n",
        },
        "/workspace",
      );
      const up = await provider.executeCommand(
        sandbox.id,
        "docker compose up -d && docker ps --format '{{.Names}}'",
        { timeout: 300 },
      );
      expect(up.exitCode, up.result).toBe(0);
      // Attached runs and exec hijack the connection through the endpoint.
      const attached = await provider.executeCommand(
        sandbox.id,
        "docker run --rm alpine echo attached-ok && docker compose exec -T web cat /built && docker compose exec -T web echo exec-ok",
        { timeout: 300 },
      );
      expect(attached.result).toContain("attached-ok");
      expect(attached.result).toContain("exec-ok");
      expect(attached.result).toContain("built");
      const privileged = await provider.executeCommand(
        sandbox.id,
        "docker run --rm --privileged alpine true",
        { timeout: 120 },
      );
      expect(privileged.exitCode).not.toBe(0);
      expect(privileged.result).toContain("Privileged");
    } finally {
      await provider.destroySandbox(sandbox.id);
      fs.rmSync(root, { recursive: true, force: true });
    }
    const label = `label=${DOCKER_OWNER_LABEL}=${sandbox.id}`;
    const env = { ...process.env, DOCKER_HOST: `unix://${socket}` };
    for (const args of [
      ["ps", "-aq", "--filter", label],
      ["network", "ls", "-q", "--filter", label],
      ["volume", "ls", "-q", "--filter", label],
    ]) {
      const { stdout } = await run("docker", args, { env });
      expect(stdout.trim()).toBe("");
    }
  }, 600_000);
});
