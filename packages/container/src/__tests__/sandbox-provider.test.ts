import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { volumeKey } from "@catamorphic/sandbox";
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
  afterEach(async () => {
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

  it("does not offer egress policies with privileged runc containers", async () => {
    const { provider } = await setup({
      runtime: { kind: "runc", name: "runc" },
      privilegedContainers: true,
    });
    const privileged = provider();
    expect(privileged.capabilities).not.toContain("network.policy");
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
});
