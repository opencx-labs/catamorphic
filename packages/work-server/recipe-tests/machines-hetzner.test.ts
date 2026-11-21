import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeHetznerCloud } from "../../registry/src/machines-hetzner/fake-hetzner.test-support.js";
import {
  HetznerCloudError,
  hetznerMachines,
} from "../../registry/src/machines-hetzner/machines-hetzner.js";
import { workerUserData } from "../../registry/src/machines-install/machines-install.js";
import {
  compose,
  onDemand,
} from "../../registry/src/machines-policies/machines-policies.js";
import { checkMachineProvisioner, checkMachinesHook } from "../src/testing.js";

/*
 * The `machines-hetzner` recipe (ADR 0347): what the Work server's own
 * Hetzner Cloud code did, as host code, against a Hetzner kept in memory.
 */
const TOKEN = "hcloud-test-token";
const PROJECT = "7e0f7c3e-9a55-4d0b-8a35-0c0f4b1f2a10";
const DEFAULTS = {
  serverType: "cpx41",
  location: "nbg1",
  image: "ubuntu-24.04",
  sshKeys: ["ops"],
};

let cloud: FakeHetznerCloud;
const machines = (
  overrides: Partial<Parameters<typeof hetznerMachines>[0]> = {},
) =>
  hetznerMachines({
    token: TOKEN,
    defaults: DEFAULTS,
    fetch: cloud.fetch,
    userData: ({ enrollment }) =>
      workerUserData({
        enrollment,
        image: "ghcr.io/acme/work-server:1.2.3",
      }),
    ...overrides,
  });
const request = (name: string, generation = 1) => {
  const code = `wke_test-${name}-${generation}`;
  return {
    name,
    options: {},
    labels: {},
    enrollment: {
      controlPlaneUrl: "https://work.example.com",
      code,
      idempotencyKey: createHash("sha256").update(code).digest("hex"),
    },
  };
};

beforeEach(() => {
  cloud = new FakeHetznerCloud(TOKEN);
});

describe("machines on Hetzner Cloud", () => {
  it("passes the provisioner contract: one server per key, stop and start, destroy until gone", async () => {
    await checkMachineProvisioner({
      provisioner: machines(),
      platform: { count: () => cloud.alive().length },
      between: () => cloud.advance(20_000),
    });
    expect(cloud.alive()).toHaveLength(0);
  });

  it("creates a labeled server that installs the worker, once per key", async () => {
    const create = request("desk-ada");
    const made = await machines({ labels: { team: "eng" } }).create(create);
    expect(made).toEqual({ ref: "101" });
    expect(cloud.serverNamed("desk-ada")).toMatchObject({
      server_type: "cpx41",
      location: "nbg1",
      image: "ubuntu-24.04",
      ssh_keys: ["ops"],
      start_after_create: true,
      labels: {
        team: "eng",
        "work-machine": "desk-ada",
        "work-key": create.enrollment.idempotencyKey.slice(0, 63),
      },
    });
    const userData = String(cloud.serverNamed("desk-ada")?.user_data);
    expect(userData).toContain("#cloud-config");
    expect(userData).toContain(`"--code", "${create.enrollment.code}"]`);
    expect(Buffer.byteLength(userData)).toBeLessThan(32 * 1024);
    // Work repeating the create (its answer was lost) gets the same server.
    expect(await machines().create(create)).toEqual(made);
    expect(cloud.alive()).toHaveLength(1);
    // A new enrollment under a name still in use is never the same machine.
    expect(await machines().create(request("desk-ada", 2))).toEqual({
      refused: expect.stringContaining("was not made for this enrollment"),
    });
  });

  it("answers pending while the name's previous server is still being deleted, and refuses what Hetzner refuses", async () => {
    const provisioner = machines();
    const first = request("ci-1");
    const made = await provisioner.create(first);
    if (!("ref" in made)) throw new Error("Not created");
    const target = {
      name: "ci-1",
      ref: made.ref,
      idempotencyKey: first.enrollment.idempotencyKey,
      options: {},
      labels: {},
      requestedAt: new Date(cloud.now()).toISOString(),
    };
    expect(await provisioner.destroy(target)).toEqual({ done: false });
    expect(await provisioner.create(request("ci-1", 2))).toEqual({
      pending: true,
    });
    cloud.advance(20_000);
    expect(await provisioner.destroy(target)).toEqual({ done: true });
    expect(await provisioner.create(request("ci-1", 2))).toEqual({
      ref: "102",
    });

    cloud.createErrors.push({ status: 422, code: "invalid_input" });
    expect(await provisioner.create(request("ci-2"))).toEqual({
      refused: "Hetzner Cloud: invalid input (invalid_input)",
    });
    // Busy or unreachable is uncertain: thrown, and Work asks again.
    cloud.createErrors.push({ status: 503, code: "service_error" });
    await expect(provisioner.create(request("ci-3"))).rejects.toBeInstanceOf(
      HetznerCloudError,
    );
    expect(await machines({ defaults: {} }).create(request("ci-4"))).toEqual({
      refused: expect.stringContaining("serverType, location and image"),
    });
  });

  it("keeps a snapshot of the disk before it deletes a server, over as many calls as that takes", async () => {
    const provisioner = machines({ snapshot: true });
    const create = request("desk-ada");
    const made = await provisioner.create(create);
    if (!("ref" in made)) throw new Error("Not created");
    const target = {
      name: "desk-ada",
      ref: made.ref,
      idempotencyKey: create.enrollment.idempotencyKey,
      options: {},
      labels: {},
      requestedAt: new Date(cloud.now()).toISOString(),
    };
    expect(await provisioner.destroy(target)).toEqual({ done: false });
    expect(await provisioner.destroy(target)).toEqual({ done: false });
    // One snapshot was started, never a second, and the server is kept
    // until it is written.
    expect(cloud.images).toHaveLength(1);
    expect(cloud.images[0]).toMatchObject({
      status: "creating",
      labels: { "work-machine": "desk-ada", "work-server-id": made.ref },
    });
    expect(cloud.alive()).toHaveLength(1);
    cloud.advance(20_000);
    expect(await provisioner.destroy(target)).toEqual({ done: false });
    cloud.advance(20_000);
    expect(await provisioner.destroy(target)).toEqual({ done: true });
    expect(cloud.alive()).toHaveLength(0);
    expect(cloud.images).toHaveLength(1);
  });

  it("passes the whole hook contract with machines on demand from the policies pack", async () => {
    await checkMachinesHook({
      hook: {
        plan: compose(
          onDemand({
            prefix: "review",
            max: 3,
            for: [{ project: PROJECT }],
            labels: { pool: "review" },
          }),
        ),
        ...machines(),
      },
      facts: { work: [{ project: PROJECT, pool: { pool: "review" } }] },
      onAdvance: (now) => cloud.advanceTo(now),
      kill: ({ ref }) => {
        if (ref) cloud.kill(Number(ref));
      },
    });
  });
});
