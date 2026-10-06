import { describe, expect, it } from "vitest";
import {
  HetznerCloudClient,
  HetznerCloudError,
  HetznerCloudMachines,
  MACHINE_LABEL,
  SNAPSHOT_SERVER_LABEL,
} from "../index.js";
import { FakeHetznerCloud } from "../testing.js";

const TOKEN = "hcloud-test-token";

function setup(options?: {
  actionPolls?: number;
  failAction?: string;
  snapshotWaitMs?: number;
  deleteWaitMs?: number;
}) {
  const cloud = new FakeHetznerCloud({
    token: TOKEN,
    ...(options?.actionPolls !== undefined
      ? { actionPolls: options.actionPolls }
      : {}),
    ...(options?.failAction ? { failAction: options.failAction } : {}),
  });
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const client = new HetznerCloudClient({
    token: TOKEN,
    baseUrl: "https://api.hetzner.test/v1",
    fetch: cloud.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const machines = new HetznerCloudMachines({
    client,
    ...(options?.snapshotWaitMs !== undefined
      ? { snapshotWaitMs: options.snapshotWaitMs }
      : {}),
    ...(options?.deleteWaitMs !== undefined
      ? { deleteWaitMs: options.deleteWaitMs }
      : {}),
  });
  return { cloud, client, machines, sleeps };
}

const spec = {
  name: "desk-0a1b2c3d4e5f",
  serverType: "cpx41",
  location: "fsn1",
  image: "ubuntu-24.04",
  sshKeys: ["ops"],
  firewalls: [42],
  networks: [7],
  labels: { "work-class": "desk" },
  userData: "#cloud-config\nruncmd: []\n",
};

const keep = {
  description: "Work machine desk-0a1b2c3d4e5f",
  labels: { "work-rule": "desk" },
};

describe("HetznerCloudMachines", () => {
  it("creates a labeled server once, however often it is asked", async () => {
    const { cloud, machines } = setup();
    const first = await machines.create(spec);
    expect(first.created).toBe(true);
    const server = cloud.servers.get(Number(first.ref));
    expect(server).toMatchObject({
      name: spec.name,
      server_type: "cpx41",
      location: "fsn1",
      image: "ubuntu-24.04",
      user_data: spec.userData,
      ssh_keys: ["ops"],
      firewalls: [{ firewall: 42 }],
      networks: [7],
      labels: { "work-class": "desk", [MACHINE_LABEL]: spec.name },
    });

    // A retry after a lost answer finds the same server by its name.
    const again = await machines.create(spec);
    expect(again).toEqual({ ref: first.ref, created: false });
    expect(cloud.servers.size).toBe(1);
  });

  it("refuses a same-named server Work did not create, definitely", async () => {
    const { cloud, client, machines } = setup();
    await client.request({
      method: "POST",
      path: "/servers",
      body: { name: spec.name, server_type: "cx22", image: "debian-12" },
    });
    const refused = await machines.create(spec).catch((error) => error);
    expect(refused).toBeInstanceOf(HetznerCloudError);
    expect(refused.message).toMatch(/was not created by Work/);
    expect(refused.definite).toBe(true);
    expect(cloud.servers.size).toBe(1);
  });

  it("destroys by id, or by label when the id is unknown, and succeeds once gone", async () => {
    const { cloud, machines } = setup();
    const { ref } = await machines.create(spec);
    expect(
      await machines.destroy({ name: spec.name, ref: null }),
    ).toMatchObject({ done: true, deleted: [Number(ref)], snapshots: [] });
    expect(cloud.servers.size).toBe(0);
    // Already gone: nothing to do, no error.
    expect(await machines.destroy({ name: spec.name, ref })).toEqual({
      done: true,
      deleted: [],
      snapshots: [],
    });

    const second = await machines.create(spec);
    await machines.destroy({ name: spec.name, ref: second.ref });
    expect(cloud.servers.size).toBe(0);
  });

  it("deletes only a server carrying the machine's label", async () => {
    const { cloud, client, machines } = setup();
    await client.request({
      method: "POST",
      path: "/servers",
      body: { name: "someone-elses", server_type: "cx22", image: "debian-12" },
    });
    const other = cloud.serverNamed("someone-elses");
    // A stale ref pointing at another server falls back to the label.
    expect(
      await machines.destroy({ name: spec.name, ref: String(other?.id) }),
    ).toEqual({ done: true, deleted: [], snapshots: [] });
    expect(cloud.servers.size).toBe(1);
  });

  it("starts a snapshot, and destroys the server in a later call once it is written", async () => {
    const { cloud, machines } = setup({ actionPolls: 2 });
    const { ref } = await machines.create(spec);
    const destroy = () =>
      machines.destroy({ name: spec.name, ref, snapshot: keep });
    // The first call starts the snapshot and returns at once.
    expect(await destroy()).toEqual({
      done: false,
      deleted: [],
      snapshots: [],
    });
    const [image] = [...cloud.images.values()];
    expect(image).toMatchObject({
      type: "snapshot",
      status: "creating",
      description: keep.description,
      labels: {
        "work-rule": "desk",
        [MACHINE_LABEL]: spec.name,
        [SNAPSHOT_SERVER_LABEL]: ref,
      },
    });
    // Still being written: nothing more happens.
    expect((await destroy()).done).toBe(false);
    cloud.advance();
    expect(await destroy()).toEqual({
      done: true,
      deleted: [Number(ref)],
      snapshots: [image?.id],
    });
    expect(cloud.servers.size).toBe(0);
    const order = cloud.calls
      .filter((call) => call.method !== "GET")
      .map((call) => `${call.method} ${call.path}`);
    expect(order).toEqual([
      "POST /servers",
      `POST /servers/${ref}/actions/create_image`,
      `DELETE /servers/${ref}`,
    ]);
  });

  it("waits for a snapshot when asked to, within its bound", async () => {
    const { cloud, machines } = setup({ snapshotWaitMs: 60_000 });
    const { ref } = await machines.create(spec);
    const destroyed = await machines.destroy({
      name: spec.name,
      ref,
      snapshot: keep,
    });
    expect(destroyed.done).toBe(true);
    expect(destroyed.snapshots).toEqual([...cloud.images.keys()]);
  });

  it("never asks twice for a snapshot whose answer was lost", async () => {
    const { cloud, machines } = setup();
    const { ref } = await machines.create(spec);
    // Hetzner starts the image, then the answer is lost (5xx, then a
    // dropped connection): no second image, and no retry of the call.
    for (const lost of [
      { status: 502, code: "unavailable" },
      { status: 0, code: "", network: true },
    ]) {
      cloud.images.clear();
      cloud.fail({
        method: "POST",
        path: `/servers/${ref}/actions/create_image`,
        processed: true,
        ...lost,
      });
      const destroyed = await machines.destroy({
        name: spec.name,
        ref,
        snapshot: keep,
      });
      expect(destroyed.done).toBe(false);
      expect(cloud.images.size).toBe(1);
    }
    expect(
      cloud.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/create_image"),
      ),
    ).toHaveLength(2);
    // Not started at all: the error stands and a later call tries again.
    cloud.images.clear();
    cloud.fail({
      method: "POST",
      path: `/servers/${ref}/actions/create_image`,
      status: 503,
      code: "unavailable",
    });
    await expect(
      machines.destroy({ name: spec.name, ref, snapshot: keep }),
    ).rejects.toMatchObject({ status: 503 });
    expect(cloud.servers.size).toBe(1);
  });

  it("reuses a snapshot an interrupted destroy already wrote", async () => {
    const { cloud, machines } = setup();
    const { ref } = await machines.create(spec);
    await machines.destroy({ name: spec.name, ref, snapshot: keep });
    cloud.advance();
    // The snapshot is written, then the delete fails.
    cloud.fail({ method: "DELETE", status: 423, code: "locked" });
    await expect(
      machines.destroy({ name: spec.name, ref, snapshot: keep }),
    ).rejects.toMatchObject({ code: "locked" });
    const retried = await machines.destroy({
      name: spec.name,
      ref,
      snapshot: keep,
    });
    expect(cloud.images.size).toBe(1);
    expect(retried).toEqual({
      done: true,
      deleted: [Number(ref)],
      snapshots: [...cloud.images.keys()],
    });
  });

  it("does not delete a server whose snapshot failed, and starts it again", async () => {
    const { cloud, machines } = setup({ failAction: "create_image" });
    const { ref } = await machines.create(spec);
    expect(
      (await machines.destroy({ name: spec.name, ref, snapshot: keep })).done,
    ).toBe(false);
    cloud.advance();
    // The failed image is gone; the next call starts another.
    expect(cloud.images.size).toBe(0);
    expect(
      (await machines.destroy({ name: spec.name, ref, snapshot: keep })).done,
    ).toBe(false);
    expect(cloud.servers.size).toBe(1);
    expect(cloud.images.size).toBe(1);
  });

  it("reports a deletion Hetzner has not finished, and finishes later", async () => {
    const { cloud, machines } = setup({ actionPolls: 1_000, deleteWaitMs: 0 });
    const { ref } = await machines.create(spec);
    expect(await machines.destroy({ name: spec.name, ref })).toEqual({
      done: false,
      deleted: [],
      snapshots: [],
    });
    // Deleting: not asked again.
    expect((await machines.destroy({ name: spec.name, ref })).done).toBe(false);
    expect(cloud.calls.filter((call) => call.method === "DELETE")).toHaveLength(
      1,
    );
    cloud.advance();
    expect(await machines.destroy({ name: spec.name, ref })).toEqual({
      done: true,
      deleted: [],
      snapshots: [],
    });
  });
});

describe("HetznerCloudClient", () => {
  it("retries 429 until RateLimit-Reset and 5xx with backoff, then gives up", async () => {
    const { cloud, client, sleeps } = setup();
    cloud.fail({
      path: "/servers",
      status: 429,
      code: "rate_limit_exceeded",
      headers: { "ratelimit-reset": String(1_000 + 3) },
    });
    cloud.fail({ path: "/servers", status: 503, code: "unavailable" });
    cloud.fail({ path: "/servers", status: 0, code: "", network: true });
    expect(await client.servers({})).toEqual([]);
    // Three seconds to the reset (bounded), then exponential backoff.
    expect(sleeps).toEqual([3_000, 1_000, 2_000]);

    cloud.fail({
      path: "/servers",
      status: 500,
      code: "server_error",
      times: 10,
    });
    await expect(client.servers({})).rejects.toMatchObject({
      status: 500,
      code: "server_error",
    });
  });

  it("does not retry a definite answer", async () => {
    const { cloud, client } = setup();
    cloud.fail({ path: "/servers", status: 403, code: "forbidden" });
    await expect(client.servers({})).rejects.toBeInstanceOf(HetznerCloudError);
    expect(cloud.calls).toHaveLength(1);
  });

  it("gives up on a call that does not answer in time", async () => {
    const hung = new HetznerCloudClient({
      token: TOKEN,
      requestTimeoutMs: 20,
      maxRetries: 1,
      sleep: async () => {},
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    });
    await expect(hung.servers({})).rejects.toMatchObject({
      status: 0,
      code: "unreachable",
      definite: false,
    });
  });

  it("refuses a wrong token", async () => {
    const { cloud } = setup();
    const client = new HetznerCloudClient({
      token: "wrong",
      fetch: cloud.fetch,
    });
    await expect(client.servers({})).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("follows pagination", async () => {
    const { client, machines } = setup();
    for (let index = 0; index < 60; index++)
      await machines.create({ ...spec, name: `desk-${index}` });
    const servers = await client.servers({
      labelSelector: "work-class=desk",
    });
    expect(servers).toHaveLength(60);
    expect(new Set(servers.map((server) => server.name)).size).toBe(60);
  });

  it("stops waiting for an action at its deadline", async () => {
    const { cloud, client } = setup({ actionPolls: 1_000 });
    await client.request({
      method: "POST",
      path: "/servers",
      body: { name: "slow", server_type: "cx22", image: "debian-12" },
    });
    const [action] = [...cloud.actions.values()];
    await expect(
      client.waitForAction({ id: action?.id ?? 0, timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
