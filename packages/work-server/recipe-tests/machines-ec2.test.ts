import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Ec2Error,
  FakeEc2,
  useFakeEc2,
} from "../../registry/src/machines-ec2/fake-client-ec2.test-support.js";
import { ec2Machines } from "../../registry/src/machines-ec2/machines-ec2.js";
import { workerUserData } from "../../registry/src/machines-install/machines-install.js";
import {
  compose,
  onePerPerson,
  stopWhenIdle,
} from "../../registry/src/machines-policies/machines-policies.js";
import {
  checkMachineProvisioner,
  checkMachinesHook,
  SimulatedWork,
} from "../src/testing.js";

/*
 * The `machines-ec2` recipe (ADR 0347) against its fake EC2: no AWS call is
 * made. The recipe typechecks against the real client.
 */
vi.mock(
  "@aws-sdk/client-ec2",
  () =>
    import("../../registry/src/machines-ec2/fake-client-ec2.test-support.js"),
);

const IMAGE = "111122223333.dkr.ecr.eu-west-1.amazonaws.com/work-worker:1.2.3";
const DEFAULTS = {
  instanceType: "r7i.2xlarge",
  image:
    "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
  subnetId: "subnet-0abc",
  securityGroupIds: ["sg-0abc"],
  rootVolumeGb: 100,
};

let fake: FakeEc2;
const machines = (overrides: Partial<Parameters<typeof ec2Machines>[0]> = {}) =>
  ec2Machines({
    region: "eu-west-1",
    defaults: DEFAULTS,
    tags: { "work-server": "prod" },
    userData: ({ enrollment }) =>
      workerUserData({ enrollment, image: IMAGE, registry: "ecr" }),
    now: fake.now,
    ...overrides,
  });

const request = (name: string, generation = 1) => {
  const code = `wke_test-${name}-${generation}`;
  return {
    name,
    options: {},
    labels: { pool: "review" },
    enrollment: {
      controlPlaneUrl: "https://work.example.com",
      code,
      idempotencyKey: createHash("sha256").update(code).digest("hex"),
    },
  };
};

beforeEach(() => {
  fake = new FakeEc2();
  useFakeEc2(fake);
});

describe("machines on EC2", () => {
  it("passes the provisioner contract: one instance per key, stop and start, destroy until gone", async () => {
    await checkMachineProvisioner({
      provisioner: machines(),
      platform: { count: () => fake.alive().length },
      between: () => fake.advance(30_000),
    });
    // The check's machine (asked for twice, made once) and its lost-answer orphan.
    expect(
      fake.calls.filter((call) => call.command === "RunInstances"),
    ).toHaveLength(3);
    expect(fake.alive()).toHaveLength(0);
  });

  it("launches with the enrollment's key as its ClientToken, IMDSv2, tags, and a disk that survives a stop", async () => {
    const create = request("desk-ada");
    const answer = await machines().create(create);
    expect(answer).toEqual({ ref: "i-00000000000000001" });
    const launched = fake.launch("i-00000000000000001");
    expect(launched).toMatchObject({
      ClientToken: create.enrollment.idempotencyKey,
      ImageId: DEFAULTS.image,
      InstanceType: "r7i.2xlarge",
      SubnetId: "subnet-0abc",
      SecurityGroupIds: ["sg-0abc"],
      MetadataOptions: {
        HttpTokens: "required",
        HttpPutResponseHopLimit: 1,
      },
      // Never "terminate": Work's stop keeps the machine and its disk.
      InstanceInitiatedShutdownBehavior: "stop",
      BlockDeviceMappings: [
        { DeviceName: "/dev/sda1", Ebs: { VolumeSize: 100, Encrypted: true } },
      ],
    });
    expect(create.enrollment.idempotencyKey).toHaveLength(64);
    const tags = launched?.TagSpecifications?.[0]?.Tags;
    expect(tags).toEqual([
      { Key: "work-server", Value: "prod" },
      { Key: "work-machine", Value: "desk-ada" },
      { Key: "Name", Value: "desk-ada" },
    ]);
    expect(launched?.TagSpecifications?.[1]).toMatchObject({
      ResourceType: "volume",
      Tags: tags,
    });
    // The user data installs the worker with this enrollment and logs in to
    // the private registry; gzipped when it would not fit EC2's limit.
    const raw = Buffer.from(launched?.UserData ?? "", "base64");
    const userData = (
      raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
    ).toString();
    expect(raw.byteLength).toBeLessThanOrEqual(16_384);
    expect(userData).toContain("#cloud-config");
    expect(userData).toContain(
      `"--code", "${create.enrollment.code}", "--registry", "ecr"]`,
    );
    // Work repeating the create gets the same instance back.
    expect(await machines().create(create)).toEqual(answer);
    expect(fake.alive()).toHaveLength(1);
  });

  it("lays a plan entry's options over the defaults, and refuses what EC2 would refuse again", async () => {
    const provisioner = machines();
    const sized = await provisioner.create({
      ...request("ci-1"),
      options: { instanceType: "m7i.large", rootVolumeGb: 40 },
    });
    expect("ref" in sized && fake.launch(sized.ref)).toMatchObject({
      InstanceType: "m7i.large",
      BlockDeviceMappings: [{ Ebs: { VolumeSize: 40 } }],
    });
    expect(
      await provisioner.create({
        ...request("ci-2"),
        options: { instanceType: "z99.mega" },
      }),
    ).toEqual({ refused: expect.stringContaining("z99.mega is unknown") });
    expect(await machines({ defaults: {} }).create(request("ci-3"))).toEqual({
      refused: expect.stringContaining("instanceType, image and subnetId"),
    });
    // Nothing was launched and asking again would fail the same way.
    fake.fail(
      "RunInstances",
      new Ec2Error("InsufficientInstanceCapacity", "none in eu-west-1a"),
    );
    expect(await provisioner.create(request("ci-4"))).toEqual({
      refused: "InsufficientInstanceCapacity: none in eu-west-1a",
    });
    // Throttling is uncertain: it is thrown, and Work repeats with its key.
    fake.fail("RunInstances", new Ec2Error("RequestLimitExceeded"));
    await expect(provisioner.create(request("ci-5"))).rejects.toThrow(
      "RequestLimitExceeded",
    );
    expect(await provisioner.create(request("ci-5"))).toMatchObject({
      ref: expect.stringMatching(/^i-/),
    });
    expect(() => machines({ tags: { Name: "mine" } })).toThrow("Work's own");
  });

  it("stops and starts the same instance, and says when it is gone", async () => {
    const provisioner = machines();
    const create = request("desk-ada");
    const made = await provisioner.create(create);
    if (!("ref" in made)) throw new Error("Not created");
    const target = {
      name: "desk-ada",
      ref: made.ref,
      idempotencyKey: create.enrollment.idempotencyKey,
      options: {},
      labels: {},
      requestedAt: new Date().toISOString(),
    };
    fake.advance(30_000);
    expect(await provisioner.describe?.(target)).toEqual({ state: "running" });
    expect(await provisioner.stop?.(target)).toEqual({ done: false });
    expect(await provisioner.stop?.(target)).toEqual({ done: false });
    fake.advance(30_000);
    expect(await provisioner.stop?.(target)).toEqual({ done: true });
    expect(await provisioner.describe?.(target)).toEqual({ state: "stopped" });
    expect(fake.alive()).toEqual([
      { id: made.ref, state: "stopped", name: "desk-ada" },
    ]);
    expect(
      fake.calls.filter((call) => call.command === "StopInstances"),
    ).toHaveLength(1);

    expect(await provisioner.start?.(target)).toEqual({ done: false });
    fake.advance(30_000);
    expect(await provisioner.start?.(target)).toEqual({ done: true });
    expect(
      fake.calls.filter((call) => call.command === "StartInstances"),
    ).toHaveLength(1);
    expect(fake.alive()).toEqual([
      { id: made.ref, state: "running", name: "desk-ada" },
    ]);

    // Terminated behind Work's back: start says gone, describe too.
    fake.kill(made.ref);
    expect(await provisioner.start?.(target)).toEqual({ gone: true });
    expect(await provisioner.describe?.(target)).toEqual({ state: "gone" });
    // Listed no more after an hour: it cannot say, and Work waits out its limit.
    fake.advance(2 * 60 * 60_000);
    expect(await provisioner.describe?.(target)).toEqual({ state: "unknown" });
  });

  it("launches Spot one-time and refuses to stop it", async () => {
    const provisioner = machines();
    const create = { ...request("burst-1"), options: { market: "spot" } };
    const made = await provisioner.create(create);
    if (!("ref" in made)) throw new Error("Not created");
    const launched = fake.launch(made.ref);
    expect(launched?.InstanceMarketOptions).toMatchObject({
      MarketType: "spot",
      SpotOptions: { SpotInstanceType: "one-time" },
    });
    expect(launched?.InstanceInitiatedShutdownBehavior).toBeUndefined();
    fake.advance(30_000);
    await expect(
      provisioner.stop?.({
        name: "burst-1",
        ref: made.ref,
        idempotencyKey: create.enrollment.idempotencyKey,
        options: create.options,
        labels: {},
        requestedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("cannot be stopped");
    expect(
      fake.calls.filter((call) => call.command === "StopInstances"),
    ).toHaveLength(0);
  });

  it("destroys a launch whose answer was lost, and waits out EC2's late listing before calling a machine gone", async () => {
    const provisioner = machines();
    const create = request("review-pr-7");
    // EC2 lists a new instance late.
    fake.listingLagMs = 2 * 60_000;
    await provisioner.create(create);
    const requestedAt = new Date(fake.now()).toISOString();
    const target = {
      name: "review-pr-7",
      ref: null,
      idempotencyKey: create.enrollment.idempotencyKey,
      options: {},
      labels: {},
      requestedAt,
    };
    // Not listed yet: never done this soon after Work first asked.
    expect(await provisioner.destroy(target)).toEqual({ done: false });
    expect(
      fake.calls.filter((call) => call.command === "TerminateInstances"),
    ).toHaveLength(0);
    fake.advance(3 * 60_000);
    // Listed now, found by its ClientToken alone, and terminated.
    expect(await provisioner.destroy(target)).toEqual({ done: false });
    expect(
      fake.calls.filter((call) => call.command === "TerminateInstances"),
    ).toHaveLength(1);
    fake.advance(60_000);
    expect(await provisioner.destroy(target)).toEqual({ done: true });
    expect(fake.alive()).toHaveLength(0);
    // A machine no key or id finds is gone once the grace has passed.
    const unknown = {
      ...target,
      idempotencyKey: null,
      name: "never-made",
      requestedAt: new Date(fake.now()).toISOString(),
    };
    expect(await provisioner.destroy(unknown)).toEqual({ done: false });
    fake.advance(11 * 60_000);
    expect(await provisioner.destroy(unknown)).toEqual({ done: true });
  });

  it("passes the whole hook contract with a plan from the policies pack", async () => {
    await checkMachinesHook({
      hook: {
        plan: compose(
          onePerPerson({
            prefix: "desk",
            people: ({ people }) => people,
            labels: { pool: "desk" },
          }),
        ),
        ...machines(),
      },
      facts: {
        people: ["ada", "grace"].map((id) => ({
          id,
          email: `${id}@example.com`,
          name: id,
          active: true,
          administrator: false,
          roles: {},
        })),
      },
      onAdvance: (now) => fake.advanceTo(now),
      kill: ({ ref }) => {
        if (ref) fake.kill(ref);
      },
    });
    expect(
      fake
        .alive()
        .map((instance) => instance.name)
        .sort(),
    ).toEqual(["desk-ada", "desk-grace"]);
  });

  it("stops an idle desk and brings the same instance back when its owner's chat waits", async () => {
    const hook = {
      plan: compose(
        onePerPerson({ prefix: "desk", people: ({ people }) => people }),
        stopWhenIdle({ minutes: 30 }),
      ),
      ...machines(),
    };
    const sim = new SimulatedWork({
      hook,
      people: [
        {
          id: "ada",
          email: "ada@example.com",
          name: "Ada",
          active: true,
          administrator: false,
          roles: {},
        },
      ],
    });
    const step = async (minutes: number) => {
      sim.advance({ minutes });
      fake.advanceTo(sim.now);
      await sim.pass();
    };
    await sim.pass();
    for (let index = 0; index < 4; index += 1) await step(1);
    expect(sim.machine("desk-ada")).toMatchObject({ state: "serving" });
    const [instance] = fake.alive();
    await step(31);
    await step(1);
    await step(1);
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "stopped",
      reason: expect.stringContaining("Stopped after 30 idle minutes"),
    });
    expect(fake.alive()).toEqual([{ ...instance, state: "stopped" }]);

    const chat = sim.addWork({
      project: "7e0f7c3e-9a55-4d0b-8a35-0c0f4b1f2a10",
      user: "ada",
    });
    await sim.pass();
    expect(sim.startingFor(chat.id)).toEqual({
      name: "desk-ada",
      state: "resuming",
    });
    for (let index = 0; index < 3; index += 1) await step(1);
    expect(sim.placedOn(chat.id)).toBe("desk-ada");
    // The same instance, never a second one.
    expect(fake.alive()).toEqual([{ ...instance, state: "running" }]);
    expect(
      fake.calls.filter((call) => call.command === "RunInstances"),
    ).toHaveLength(1);
  });
});
