import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  cacheVolumeKey,
  dockerfileDigest,
  dockerfileImageReference,
  volumeKey,
} from "@catamorphic/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContainerProviderConfig,
  ContainerSandboxProvider,
  SANDBOX_NETWORK,
} from "../sandbox-provider.js";
import { startFakeDocker } from "./fake-docker.js";

/** The container provider's own logic against an in-memory daemon. */
describe("ContainerSandboxProvider without Docker", () => {
  const fakes: Array<Awaited<ReturnType<typeof startFakeDocker>>> = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const fake of fakes.splice(0)) await fake.close();
  });

  async function setup(
    config?: Partial<ContainerProviderConfig>,
    fakeOptions?: Parameters<typeof startFakeDocker>[0],
  ) {
    const fake = await startFakeDocker(fakeOptions);
    fakes.push(fake);
    const stateDirectory = path.join(fake.directory, "state");
    const provider = (overrides?: Partial<ContainerProviderConfig>) =>
      new ContainerSandboxProvider({
        docker: fake.docker,
        runtime: {
          kind: "runsc",
          name: "runsc",
          hostSockets: true,
          netRaw: true,
        },
        stateDirectory,
        setupCommand: "",
        hostPathOf: (local) => local,
        nameservers: ["192.0.2.53"],
        ...config,
        ...overrides,
      });
    return { fake, stateDirectory, provider };
  }

  const hostConfigOf = (body: Record<string, unknown>) => {
    const hostConfig = body.HostConfig;
    if (typeof hostConfig !== "object" || hostConfig === null)
      throw new Error("No HostConfig");
    return Object.fromEntries(Object.entries(hostConfig));
  };

  it("puts open sandboxes on a network without inter-container traffic, with a process limit", async () => {
    const { fake, provider, stateDirectory } = await setup();
    const sandbox = await provider().createSandbox({});
    expect(fake.networks.get(SANDBOX_NETWORK)).toMatchObject({
      Options: { "com.docker.network.bridge.enable_icc": "false" },
      Labels: { "work.network": "1" },
    });
    const hostConfig = hostConfigOf(
      fake.containers.get(sandbox.id)?.body ?? {},
    );
    expect(hostConfig.NetworkMode).toBe(SANDBOX_NETWORK);
    expect(hostConfig.PidsLimit).toBe(4096);
    expect(hostConfig.Mounts).toContainEqual({
      Type: "bind",
      Source: path.join(stateDirectory, "resolv.conf"),
      Target: "/etc/resolv.conf",
      ReadOnly: true,
    });
    expect(
      fs.readFileSync(path.join(stateDirectory, "resolv.conf"), "utf8"),
    ).toBe("nameserver 192.0.2.53\n");
    // A second sandbox reuses the network.
    await provider({ pidsLimit: 512 }).createSandbox({});
    expect(
      fake.requests.filter((request) => request === "POST /networks/create"),
    ).toHaveLength(1);
    expect(
      [...fake.containers.values()].map(
        (container) => hostConfigOf(container.body).PidsLimit,
      ),
    ).toEqual([4096, 512]);
  });

  it("refuses a network of that name that lets containers reach each other", async () => {
    const { fake, provider } = await setup();
    fake.networks.set(SANDBOX_NETWORK, { Name: SANDBOX_NETWORK, Options: {} });
    await expect(provider().createSandbox({})).rejects.toThrow(
      "lets its containers reach each other",
    );
  });

  it("keeps restricted sandboxes off every network", async () => {
    const { fake, provider } = await setup();
    const sandbox = await provider().createSandbox({
      egress: { mode: "allowlist", allow: ["example.com"] },
    });
    expect(
      hostConfigOf(fake.containers.get(sandbox.id)?.body ?? {}).NetworkMode,
    ).toBe("none");
    await provider().destroySandbox(sandbox.id);
  });

  it("gives every volume, ~ and absolute ones included, to a non-root image user", async () => {
    const { fake, provider } = await setup({}, { image: { User: "node" } });
    const sandbox = await provider().createSandbox({
      volumes: [
        {
          key: volumeKey({ projectId: "p", owner: "m", name: "home" }),
          path: "~",
        },
        {
          key: volumeKey({ projectId: "p", owner: "m", name: "data" }),
          path: "/data/db",
        },
        {
          key: volumeKey({ projectId: "p", owner: "m", name: "scratch" }),
          path: "/scratch",
          temporary: true,
        },
      ],
    });
    const chown = fake.commands().find((cmd) => cmd.includes("work-own"));
    expect(chown?.slice(chown.indexOf("work-own") + 1)).toEqual(
      expect.arrayContaining([
        "node",
        "/workspace",
        "/home/node",
        "/data/db",
        "/scratch",
      ]),
    );
    // Bind mounts are the machine's own files.
    expect(chown).not.toContain("/etc/resolv.conf");
    expect(sandbox.status).toBe("started");
  });

  it("refuses volumes that land inside one another once ~ is resolved", async () => {
    const { provider } = await setup({}, { image: { User: "node" } });
    await expect(
      provider().createSandbox({
        volumes: [
          {
            key: volumeKey({ projectId: "p", owner: "m", name: "a" }),
            path: "~/x",
          },
          {
            key: volumeKey({ projectId: "p", owner: "m", name: "b" }),
            path: "/home/node/x/y",
          },
        ],
      }),
    ).rejects.toThrow("are nested");
  });

  /**
   * A restricted sandbox, an echo server its own policy does not admit and
   * a wider one does, and a CONNECT through its proxy answering the status.
   */
  async function widening() {
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = echo.address();
    if (typeof address !== "object" || address === null)
      throw new Error("No port");
    closers.push(() => new Promise((resolve) => echo.close(() => resolve())));
    const own = ["registry.test"];
    const wide = {
      mode: "allowlist" as const,
      allow: [`127.0.0.1:${address.port}`],
    };
    const { fake, provider, stateDirectory } = await setup({
      lookup: async () => [{ address: "192.0.2.1", family: 4 }],
    });
    const first = provider();
    const sandbox = await first.createSandbox({
      egress: { mode: "allowlist", allow: own },
    });
    const socketPath = path.join(
      stateDirectory,
      "egress",
      sandbox.id,
      "proxy.sock",
    );
    const connect = () =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        let reply = "";
        socket.on("data", (chunk) => {
          reply += chunk.toString();
          if (reply.includes("\r\n\r\n")) socket.destroy();
        });
        socket.on("close", () => resolve(reply.split("\r\n")[0] ?? ""));
        socket.on("error", reject);
        socket.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\n\r\n`);
      });
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    return { fake, provider, first, sandbox, own, wide, connect, later };
  }

  it("widens a restricted sandbox in memory only, back to its own when narrowed or started again", async () => {
    const { fake, provider, first, sandbox, own, wide, connect, later } =
      await widening();
    expect(first.capabilities).toContain("network.setup");
    expect(await connect()).toMatch(/403/);
    await first.widenEgress({
      sandboxId: sandbox.id,
      egress: wide,
      id: "setup-1",
      until: later(60_000),
    });
    expect(await connect()).toMatch(/200 Connection Established/);
    // The container's label keeps the Environment's own policy.
    expect(fake.containers.get(sandbox.id)?.body.Labels).toMatchObject({
      "work.sandbox.egress": JSON.stringify({ allow: own }),
    });
    await first.narrowEgress({ sandboxId: sandbox.id, id: "setup-1" });
    expect(await connect()).toMatch(/403/);

    // Widened, then stopped and started: its own policy again.
    await first.widenEgress({
      sandboxId: sandbox.id,
      egress: wide,
      id: "setup-2",
      until: later(60_000),
    });
    await first.stopSandbox(sandbox.id);
    await first.startSandbox(sandbox.id);
    expect(await connect()).toMatch(/403/);

    // A worker that restarts finds the sandbox running, narrow.
    await first.widenEgress({
      sandboxId: sandbox.id,
      egress: wide,
      id: "setup-3",
      until: later(60_000),
    });
    await first.stopSandbox(sandbox.id);
    const container = fake.containers.get(sandbox.id);
    if (container) container.running = true;
    const restarted = provider();
    await restarted.startSandbox(sandbox.id);
    expect(await connect()).toMatch(/403/);
    await restarted.destroySandbox(sandbox.id);
  });

  it("narrows by itself when a widening's time is up, with no one asking", async () => {
    const { first, sandbox, wide, connect, later } = await widening();
    await first.widenEgress({
      sandboxId: sandbox.id,
      egress: wide,
      id: "abandoned",
      until: later(300),
    });
    expect(await connect()).toMatch(/200 Connection Established/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await connect()).toMatch(/403/);
    await expect(
      first.widenEgress({
        sandboxId: sandbox.id,
        egress: wide,
        id: "too-late",
        until: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow("time has passed");
    await first.destroySandbox(sandbox.id);
  });

  it("refuses a widening that arrives after its narrowing, and one another setup holds", async () => {
    const { first, sandbox, wide, connect, later } = await widening();
    // The controller gave up waiting and narrowed; its widening arrives late.
    await first.narrowEgress({ sandboxId: sandbox.id, id: "late" });
    await expect(
      first.widenEgress({
        sandboxId: sandbox.id,
        egress: wide,
        id: "late",
        until: later(60_000),
      }),
    ).rejects.toThrow("already ended");
    expect(await connect()).toMatch(/403/);
    await first.widenEgress({
      sandboxId: sandbox.id,
      egress: wide,
      id: "current",
      until: later(60_000),
    });
    await expect(
      first.widenEgress({
        sandboxId: sandbox.id,
        egress: wide,
        id: "other",
        until: later(60_000),
      }),
    ).rejects.toThrow("Another setup");
    // Narrowing is always safe: any id returns it to its own policy.
    await first.narrowEgress({ sandboxId: sandbox.id, id: "pre-turn" });
    expect(await connect()).toMatch(/403/);
    await first.destroySandbox(sandbox.id);
  });

  it("refuses to widen an open sandbox, or a restricted one to open", async () => {
    const { provider } = await setup();
    const sandboxProvider = provider();
    const until = new Date(Date.now() + 60_000).toISOString();
    const open = await sandboxProvider.createSandbox({});
    await expect(
      sandboxProvider.widenEgress({
        sandboxId: open.id,
        egress: { mode: "allowlist", allow: ["example.com"] },
        id: "a",
        until,
      }),
    ).rejects.toThrow("created with open egress");
    const restricted = await sandboxProvider.createSandbox({
      egress: { mode: "allowlist", allow: ["example.com"] },
    });
    await expect(
      sandboxProvider.widenEgress({
        sandboxId: restricted.id,
        egress: { mode: "open" },
        id: "b",
        until,
      }),
    ).rejects.toThrow("only to another allowlist");
    await sandboxProvider.destroySandbox(restricted.id);
  });

  it("does not offer egress policies with privileged runc containers", async () => {
    const { provider } = await setup({
      runtime: { kind: "runc", name: "runc" },
      privilegedContainers: true,
    });
    const privileged = provider();
    expect(privileged.capabilities).not.toContain("network.policy");
    expect(privileged.capabilities).not.toContain("network.setup");
    expect(privileged.capabilities).toContain("containers");
    await expect(
      privileged.createSandbox({
        egress: { mode: "allowlist", allow: ["example.com"] },
      }),
    ).rejects.toThrow("privileged containers");
    const plain = provider({ privilegedContainers: false });
    expect(plain.capabilities).toContain("network.policy");
    expect(plain.capabilities).not.toContain("containers");
  });

  it("reclaims sandboxes a dead process left half made, and only those", async () => {
    const { fake, provider, stateDirectory } = await setup();
    // A process that has exited: its pid names nobody now.
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    for (const id of ["orphan", "alive", "kept"])
      fake.containers.set(id, {
        id,
        body: { Labels: { "work.sandbox": "1" } },
        running: true,
      });
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(stateDirectory, "creating.json"),
      JSON.stringify([
        { id: "orphan", pid: dead, instance: "gone" },
        // This process's pid, an instance it never made: a restarted pid 1.
        { id: "reused", pid: process.pid, instance: "earlier" },
        // Another process still running.
        { id: "alive", pid: process.ppid, instance: "other" },
      ]),
    );
    fake.containers.set("reused", {
      id: "reused",
      body: { Labels: { "work.sandbox": "1" } },
      running: false,
    });
    const reclaiming = provider();
    // Creating waits for the reclaim.
    await reclaiming.createSandbox({});
    expect(fake.containers.has("orphan")).toBe(false);
    expect(fake.containers.has("reused")).toBe(false);
    expect(fake.containers.has("alive")).toBe(true);
    expect(fake.containers.has("kept")).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stateDirectory, "creating.json"), "utf8"),
      ).map((entry: { id: string }) => entry.id),
    ).toEqual(["alive"]);
  });

  it("removes a sandbox whose start failed and forgets its creation", async () => {
    const { fake, provider, stateDirectory } = await setup(
      {},
      { failStart: "no runtime" },
    );
    await expect(provider().createSandbox({})).rejects.toThrow("no runtime");
    expect(fake.containers.size).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stateDirectory, "creating.json"), "utf8"),
      ),
    ).toEqual([]);
  });

  const generation = (n: number) =>
    cacheVolumeKey({
      projectId: "p",
      environment: "review",
      name: "pnpm",
      generation: n,
    });

  it("never creates a read-only cache generation the machine lacks, and reports it (ADR 0334)", async () => {
    const { fake, provider } = await setup();
    const handle = await provider().createSandbox({
      volumes: [{ key: generation(3), path: "/cache", readOnly: true }],
    });
    expect(handle.skippedVolumes).toEqual([generation(3)]);
    expect(fake.volumes.has(`work-volume-${generation(3)}`)).toBe(false);
    const body = fake.containers.get(handle.id)?.body;
    expect(JSON.stringify(body)).not.toContain(generation(3));
  });

  it("retires only the generations it is told to, never between another sandbox finding one and mounting it (ADR 0334)", async () => {
    let hold: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      hold = resolve;
    });
    let reached: () => void = () => {};
    const midway = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { fake, provider } = await setup(undefined, {
      // The sandbox mounting generation 5 read only is held just before
      // its container exists.
      beforeCreateContainer: async (body) => {
        const mounts = Reflect.get(hostConfigOf(body), "Mounts");
        const cache = (Array.isArray(mounts) ? mounts : []).find(
          (mount: unknown) =>
            typeof mount === "object" &&
            mount !== null &&
            Reflect.get(mount, "Source") === `work-volume-${generation(5)}`,
        );
        if (cache && Reflect.get(cache, "ReadOnly") === true) {
          reached();
          await held;
        }
      },
    });
    const machine = provider();
    for (const n of [5, 6, 7]) {
      const fill = await machine.createSandbox({
        volumes: [{ key: generation(n), path: "/cache" }],
      });
      await machine.destroySandbox(fill.id);
    }
    // A sandbox chose generation 5 before 6 was published.
    const late = machine.createSandbox({
      volumes: [{ key: generation(5), path: "/cache", readOnly: true }],
    });
    await midway;
    // Generation 6 is published: its sandbox retires 5 and the failed 7.
    const current = machine.createSandbox({
      volumes: [
        {
          key: generation(6),
          path: "/cache",
          readOnly: true,
          retire: [
            generation(5),
            generation(7),
            volumeKey({ projectId: "p", owner: "m", name: "x" }),
          ],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Its check waits for the held sandbox's container.
    expect(fake.volumes.has(`work-volume-${generation(5)}`)).toBe(true);
    hold?.();
    const [first, second] = await Promise.all([late, current]);
    expect(first.skippedVolumes).toBeUndefined();
    expect(second.skippedVolumes).toBeUndefined();
    // 5 is mounted, so it stays; 7 is gone; 6 is kept.
    expect(fake.volumes.has(`work-volume-${generation(5)}`)).toBe(true);
    expect(fake.volumes.has(`work-volume-${generation(6)}`)).toBe(true);
    expect(fake.volumes.has(`work-volume-${generation(7)}`)).toBe(false);
    // Once nothing mounts 5, the next sandbox told to retire it does.
    await machine.destroySandbox(first.id);
    await machine.createSandbox({
      volumes: [
        {
          key: generation(6),
          path: "/cache",
          readOnly: true,
          retire: [generation(5)],
        },
      ],
    });
    expect(fake.volumes.has(`work-volume-${generation(5)}`)).toBe(false);
  });

  it("never removes a cache generation between a sandbox finding it and mounting it when every volume is removed (ADR 0334)", async () => {
    let hold: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      hold = resolve;
    });
    let reached: () => void = () => {};
    const midway = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { fake, provider } = await setup(undefined, {
      beforeCreateContainer: async (body) => {
        const mounts = Reflect.get(hostConfigOf(body), "Mounts");
        const cache = (Array.isArray(mounts) ? mounts : []).find(
          (mount: unknown) =>
            typeof mount === "object" &&
            mount !== null &&
            Reflect.get(mount, "Source") === `work-volume-${generation(4)}` &&
            Reflect.get(mount, "ReadOnly") === true,
        );
        if (cache) {
          reached();
          await held;
        }
      },
    });
    const machine = provider();
    const fill = await machine.createSandbox({
      volumes: [{ key: generation(4), path: "/cache" }],
    });
    await machine.destroySandbox(fill.id);
    const reader = machine.createSandbox({
      volumes: [{ key: generation(4), path: "/cache", readOnly: true }],
    });
    await midway;
    // Settled into a value at once, so its refusal is never unhandled.
    const removal = machine.volumes.removeAll().then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.volumes.has(`work-volume-${generation(4)}`)).toBe(true);
    hold?.();
    const handle = await reader;
    // The reader holds it now, so the removal keeps it and says so.
    const refused = await removal;
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain("still mounted by sandboxes");
    expect(handle.skippedVolumes).toBeUndefined();
    expect(fake.volumes.has(`work-volume-${generation(4)}`)).toBe(true);
  });

  it("makes Work's own sandbox with no network at all and no setup (ADR 0334)", async () => {
    const ran: string[][] = [];
    const { fake, provider } = await setup(
      { setupCommand: "apk add --no-cache git" },
      {
        onExec: ({ cmd }) => {
          ran.push(cmd);
          return undefined;
        },
      },
    );
    const machine = provider();
    const internal = await machine.createSandbox({
      internal: true,
      volumes: [{ key: generation(8), path: "/cache", readOnly: true }],
    });
    const body = fake.containers.get(internal.id)?.body ?? {};
    expect(hostConfigOf(body).NetworkMode).toBe("none");
    // No resolver, no proxy socket: nothing to reach anything with.
    const mounts = Reflect.get(hostConfigOf(body), "Mounts");
    expect(
      (Array.isArray(mounts) ? mounts : []).filter(
        (mount: unknown) =>
          typeof mount === "object" &&
          mount !== null &&
          Reflect.get(mount, "Type") === "bind",
      ),
    ).toEqual([]);
    expect(ran.some((cmd) => cmd.join(" ").includes("apk add"))).toBe(false);
    // An ordinary sandbox still gets its network and its setup.
    const ordinary = await machine.createSandbox({});
    expect(
      hostConfigOf(fake.containers.get(ordinary.id)?.body ?? {}).NetworkMode,
    ).toBe(SANDBOX_NETWORK);
    expect(ran.some((cmd) => cmd.join(" ").includes("apk add"))).toBe(true);
    // It takes nothing an Environment asks for.
    await expect(
      machine.createSandbox({
        internal: true,
        egress: { mode: "allowlist", allow: ["example.com"] },
      }),
    ).rejects.toThrow("takes no egress, containers, sign-ins");
    // Nor is it ever a pair whose commands run apart (ADR 0332).
    const before = fake.containers.size;
    await expect(
      machine.createSandbox({
        internal: true,
        separateCommands: { shared: ["/workspace/project"] },
      }),
    ).rejects.toThrow("separated commands");
    expect(fake.containers.size).toBe(before);
  });

  it("removes its own sandboxes before volumes only when asked", async () => {
    const { fake, provider } = await setup();
    const key = volumeKey({ projectId: "p", owner: "m", name: "cache" });
    const mine = provider();
    const sandbox = await mine.createSandbox({
      volumes: [{ key, path: "/cache" }],
    });
    // Another provider's sandbox on the same daemon is not this one's.
    fake.containers.set("neighbour", {
      id: "neighbour",
      body: { Labels: { "work.sandbox": "1", "work.sandbox.owner": "else" } },
      running: true,
    });
    await expect(mine.volumes.removeAll()).rejects.toThrow(
      "still mounted by sandboxes",
    );
    expect(fake.containers.has(sandbox.id)).toBe(true);
    await mine.volumes.removeAll({ destroySandboxes: true });
    expect(fake.containers.has(sandbox.id)).toBe(false);
    expect(fake.containers.has("neighbour")).toBe(true);
    expect(fake.volumes.size).toBe(0);
  });

  it("reports a command whose sandbox the kernel killed, and starts it for the next", async () => {
    // gVisor: past its memory limit the whole sandbox dies, and runsc says
    // it lost the sandbox before Docker notices.
    const { fake, provider } = await setup(undefined, {
      onExec: ({ container, cmd }) => {
        if (!cmd.join(" ").includes("allocate-forever")) return undefined;
        container.running = false;
        container.oomKilled = true;
        return {
          exitCode: 128,
          stderr:
            'waiting on PID 10: urpc method "containerManager.WaitPID" failed: EOF',
        };
      },
    });
    const sandboxProvider = provider();
    const sandbox = await sandboxProvider.createSandbox({});
    const hog = await sandboxProvider.executeCommand(
      sandbox.id,
      "allocate-forever",
    );
    expect(hog.exitCode).toBe(137);
    expect(hog.result).toContain(
      "the sandbox ran out of memory, which ended every process in it",
    );
    const next = await sandboxProvider.executeCommand(sandbox.id, "true");
    expect(next.exitCode).toBe(0);
    expect(
      fake.requests.filter(
        (request) => request === `POST /containers/${sandbox.id}/start`,
      ),
    ).toHaveLength(2);
  });

  it("starts a sandbox the daemon stopped behind its back, once, and goes on", async () => {
    const { fake, provider } = await setup();
    const sandboxProvider = provider();
    const sandbox = await sandboxProvider.createSandbox({});
    const container = fake.containers.get(sandbox.id);
    if (!container) throw new Error("No container");
    container.running = false;
    await sandboxProvider.downloadFile(sandbox.id, "/workspace/a.txt");
    expect(container.running).toBe(true);
    expect(
      fake.requests.filter(
        (request) => request === `POST /containers/${sandbox.id}/start`,
      ),
    ).toHaveLength(2);
  });
  it("gives the command side the Environment's limits and the agent side its own share (ADR 0332)", async () => {
    const { fake, provider } = await setup();
    const sandbox = await provider().createSandbox({
      resources: { cpuMillis: 4000, memoryMb: 8192 },
      separateCommands: {
        shared: ["/workspace/project"],
        agentResources: { cpuMillis: 500, memoryMb: 1536 },
      },
    });
    const commands = hostConfigOf(fake.containers.get(sandbox.id)?.body ?? {});
    const agent = hostConfigOf(
      fake.containers.get(`${sandbox.id}-agent`)?.body ?? {},
    );
    expect([commands.NanoCpus, commands.Memory]).toEqual([
      4000 * 1_000_000,
      8192 * 1024 * 1024,
    ]);
    expect([agent.NanoCpus, agent.Memory, agent.MemorySwap]).toEqual([
      500 * 1_000_000,
      1536 * 1024 * 1024,
      1536 * 1024 * 1024,
    ]);
    // Without its own share, the agent side gets 1 CPU and 2 GiB.
    const plain = await provider().createSandbox({
      resources: { cpuMillis: 4000, memoryMb: 8192 },
      separateCommands: { shared: ["/workspace/project"] },
    });
    const defaults = hostConfigOf(
      fake.containers.get(`${plain.id}-agent`)?.body ?? {},
    );
    expect([defaults.NanoCpus, defaults.Memory]).toEqual([
      1000 * 1_000_000,
      2048 * 1024 * 1024,
    ]);
    for (const id of [sandbox.id, plain.id])
      await provider().destroySandbox(id);
  });
  it("stops and destroys a pair named by either side after this process restarted (ADR 0332)", async () => {
    const { fake, provider } = await setup();
    const sandbox = await provider().createSandbox({
      separateCommands: { shared: ["/workspace/project"] },
    });
    const agent = `${sandbox.id}-agent`;
    // Another process, which never saw the pair made.
    const restarted = provider();
    await restarted.stopSandbox(agent);
    const running = (name: string) => fake.containers.get(name)?.running;
    expect([running(sandbox.id), running(agent)]).toEqual([false, false]);
    await provider().destroySandbox(agent);
    expect(fake.containers.has(sandbox.id)).toBe(false);
    expect(fake.containers.has(agent)).toBe(false);
  });

  it("removes images Work pulled or built once unused for the grace, never one in use, the machine's own, or one it found (ADR 0335)", async () => {
    const { fake, provider } = await setup(undefined, {
      images: {
        "oven/bun": 1,
        "example/found:1": 1,
        // Built before this machine kept a log: counted from when it was made.
        "work.local/images:0123456789abcdef0123456789abcdef01234567": 1,
        // Another machine's build on the same daemon: never this one's.
        "work.local/images:fedcba9876543210fedcba9876543210fedcba98": 1,
      },
    });
    fake.imageLabels.set(
      "work.local/images:fedcba9876543210fedcba9876543210fedcba98",
      { "work.sandbox.owner": "another-machine" },
    );
    const machine = provider();
    const pulled = await machine.createSandbox({
      image: { kind: "oci", reference: "example/review:1" },
    });
    const found = await machine.createSandbox({
      image: { kind: "oci", reference: "example/found:1" },
    });
    await machine.createSandbox({});
    const kept = () => [...(fake.images?.keys() ?? [])].sort();
    // Used just now: only the old build is past an hour's grace.
    expect(await machine.disk.clean({ graceMs: 3_600_000 })).toEqual([
      "Removed 1 unused image: work.local/images:0123456789abcdef0123456789abcdef01234567",
    ]);
    // In use by a sandbox (Docker refuses), or never Work's: kept.
    expect(await machine.disk.clean({ graceMs: 0 })).toEqual([]);
    await machine.destroySandbox(pulled.id);
    await machine.destroySandbox(found.id);
    expect(await machine.disk.clean({ graceMs: 0 })).toEqual([
      "Removed 1 unused image: example/review:1",
    ]);
    // The machine's own image, one it had before Work, another's: never.
    expect(kept()).toEqual([
      "example/found:1",
      "oven/bun",
      "work.local/images:fedcba9876543210fedcba9876543210fedcba98",
    ]);
    // Its own builds carry its label, and go once unused.
    const dockerfile = "FROM oven/bun\nRUN true\n";
    const built = await machine.createSandbox({
      image: {
        kind: "dockerfile",
        path: ".work/images/review.Dockerfile",
        content: dockerfile,
        digest: dockerfileDigest(dockerfile),
      },
    });
    const reference = dockerfileImageReference(dockerfileDigest(dockerfile));
    expect(fake.imageLabels.get(reference)?.["work.sandbox.owner"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
    await machine.destroySandbox(built.id);
    await machine.disk.clean({ graceMs: 0 });
    expect(kept()).not.toContain(reference);
    // A later sandbox of a removed image pulls it again.
    await machine.createSandbox({
      image: { kind: "oci", reference: "example/review:1" },
    });
    expect(kept()).toContain("example/review:1");
  });

  it("prunes dangling images and build cache in running sandboxes with containers only (ADR 0335)", async () => {
    const { fake, provider } = await setup();
    const machine = provider();
    const running = await machine.createSandbox({ containers: true });
    const stopped = await machine.createSandbox({ containers: true });
    await machine.createSandbox({});
    await machine.stopSandbox(stopped.id);
    const before = fake.execs.size;
    expect(await machine.disk.clean({ graceMs: 24 * 3_600_000 })).toEqual([
      "Pruned dangling images and build cache in 1 sandbox with containers",
    ]);
    const prunes = [...fake.execs.values()]
      .slice(before)
      .filter((exec) => exec.cmd.join(" ").includes("prune"));
    expect(prunes.map((exec) => exec.container)).toEqual([running.id]);
    const script = prunes[0]?.cmd.join(" ") ?? "";
    expect(script).toContain("docker image prune --force --filter until=24h");
    expect(script).toContain("docker builder prune --force --filter until=24h");
    // Never a tagged image, a container or a volume.
    expect(script).not.toMatch(
      /--all|-a\b|system prune|volume|container prune/,
    );
  });

  it("measures its state and Docker's data root where it sees it (ADR 0335)", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "wdr-"));
    try {
      const seen = await setup(undefined, { dockerRootDir: root });
      expect(await seen.provider().disk.paths()).toEqual([
        seen.stateDirectory,
        root,
      ]);
      const unseen = await setup(undefined, {
        dockerRootDir: "/var/lib/docker-not-here",
      });
      expect(await unseen.provider().disk.paths()).toEqual([
        unseen.stateDirectory,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is given no storage limit by an Allocation, and refuses one asked directly (ADR 0335)", async () => {
    const { provider } = await setup();
    expect(provider().resourceLimits).not.toContain("storageMb");
    await expect(
      provider().createSandbox({ resources: { storageMb: 1024 } }),
    ).rejects.toThrow(/cannot limit a sandbox's disk/);
  });
});
