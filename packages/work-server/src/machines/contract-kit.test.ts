import { describe, expect, it } from "vitest";
import type { MachinePlanFacts, PersonFacts } from "./contract.js";
import {
  checkMachineProvisioner,
  checkMachinesHook,
  MachinesContractError,
  MemoryCloud,
  machinesHook,
} from "./contract-kit.js";

const PROJECT = "7e0f7c3e-9a55-4d0b-8a35-0c0f4b1f2a10";
const people: PersonFacts[] = ["ada", "grace"].map((id) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  active: true,
  administrator: false,
  roles: { [PROJECT]: ["member"] },
}));

/** One machine per active person. */
const desks = async ({ people: all }: MachinePlanFacts) =>
  all
    .filter((person) => person.active)
    .map((person) => ({
      name: `desk-${person.id}`,
      for: [{ user: person.id }],
    }));

/** The check's failure, as an agent writing the hook would read it. */
async function failure(run: Promise<void>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MachinesContractError);
  return error instanceof Error ? error.message : "";
}

describe("the machines hook contract kit (ADR 0349)", () => {
  it("passes a provisioner that honors idempotency keys, stops, starts and destroys", async () => {
    const cloud = new MemoryCloud();
    await checkMachineProvisioner({
      provisioner: cloud.provisioner(),
      platform: { count: () => cloud.alive().length },
    });
    // One that cannot stop is a provisioner too.
    await checkMachineProvisioner({
      provisioner: new MemoryCloud().provisioner({ stoppable: false }),
    });
  });

  it("passes a hook whose plan is stable and whose machines are made once and replaced when lost", async () => {
    const cloud = new MemoryCloud();
    await checkMachinesHook({
      hook: machinesHook({ plan: desks, provisioner: cloud.provisioner() }),
      facts: { people },
      kill: ({ ref }) => {
        if (ref) cloud.kill(ref);
      },
    });
    // Two desks, one of them lost and made again.
    expect(cloud.machines).toHaveLength(3);
    expect(cloud.alive()).toHaveLength(2);
  });

  it("tells a create that makes a machine per call to use the idempotency key", async () => {
    const cloud = new MemoryCloud();
    const made: string[] = [];
    const message = await failure(
      checkMachineProvisioner({
        provisioner: {
          ...cloud.provisioner(),
          create: async ({ name }) => {
            made.push(name);
            return { ref: `vm-${made.length}` };
          },
        },
      }),
    );
    expect(message).toContain("create is idempotent");
    expect(message).toContain(
      'create answered {"ref":"vm-1"} and then {"ref":"vm-2"}',
    );
    expect(message).toContain(
      "Hand enrollment.idempotencyKey to the platform as its idempotency token",
    );
  });

  it("tells a hook that loses a machine on a repeated create that the platform now has two", async () => {
    const cloud = new MemoryCloud();
    const created: string[] = [];
    const message = await failure(
      checkMachinesHook({
        hook: machinesHook({
          plan: desks,
          provisioner: {
            ...cloud.provisioner(),
            create: async ({ name }) => {
              created.push(name);
              return { ref: `vm-${created.length}` };
            },
          },
        }),
        facts: { people },
      }),
    );
    expect(message).toContain("no machine is made twice");
    expect(message).toContain("The platform now has two machines for one name");
  });

  it("tells a plan whose names change with time to derive them from something that lasts", async () => {
    const cloud = new MemoryCloud();
    let calls = 0;
    const message = await failure(
      checkMachinesHook({
        hook: machinesHook({
          plan: async () => {
            calls += 1;
            return [{ name: `desk-${calls}` }];
          },
          provisioner: cloud.provisioner(),
        }),
      }),
    );
    expect(message).toContain("plan is stable");
    expect(message).toContain("returned [desk-1] and then [desk-2]");
    expect(message).toContain("never from the time, a counter or randomness");
  });

  it("tells a plan that drops machines while they start that it flaps", async () => {
    const cloud = new MemoryCloud();
    const message = await failure(
      checkMachinesHook({
        hook: machinesHook({
          // "Missing" is read as "not serving": a machine still starting
          // is dropped and asked for again, for ever.
          plan: async ({ machines }) =>
            machines.some((machine) => machine.state === "starting")
              ? []
              : [{ name: "desk-ada", for: [{ user: "ada" }] }],
          provisioner: cloud.provisioner(),
        }),
      }),
    );
    expect(message).toMatch(/plan (converges|does not flap)/);
  });

  it("tells a destroy that never finishes what Work waits for", async () => {
    const cloud = new MemoryCloud();
    const message = await failure(
      checkMachineProvisioner({
        provisioner: {
          ...cloud.provisioner(),
          destroy: async () => ({ done: false }),
        },
      }),
    );
    expect(message).toContain("destroy finishes");
    expect(message).toContain("Work forgets the machine only then");
  });

  it("tells a stop that terminates that the machine must come back", async () => {
    const cloud = new MemoryCloud();
    const provisioner = cloud.provisioner();
    const message = await failure(
      checkMachineProvisioner({
        provisioner: {
          ...provisioner,
          stop: async (target) => {
            await provisioner.destroy({ ...target, requestedAt: "" });
            return { done: true };
          },
        },
      }),
    );
    expect(message).toContain("stop keeps the machine");
    expect(message).toContain("Do not terminate on stop");
  });

  it("tells a hook that removes a machine holding live work that only stop and destroy may", async () => {
    const cloud = new MemoryCloud();
    const provisioner = cloud.provisioner();
    const message = await failure(
      checkMachinesHook({
        hook: machinesHook({
          // A time limit enforced behind Work's back.
          plan: async ({ machines }) => {
            for (const machine of machines)
              if (machine.holding.workspaces > 0 && machine.ref)
                cloud.kill(machine.ref);
            return [{ name: "review-1", for: [{ project: PROJECT }] }];
          },
          provisioner,
        }),
        facts: { work: [{ project: PROJECT }] },
      }),
    );
    expect(message).toContain(
      "nothing holding live work is stopped or destroyed",
    );
    expect(message).toContain("Only stop and destroy end machines");
  });

  it("asks for facts when the plan wants no machine", async () => {
    const message = await failure(
      checkMachinesHook({
        hook: machinesHook({
          plan: desks,
          provisioner: new MemoryCloud().provisioner(),
        }),
      }),
    );
    expect(message).toContain("With the facts given, plan wants no machine");
  });
});
