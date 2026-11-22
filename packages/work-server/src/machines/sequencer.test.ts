import { describe, expect, it } from "vitest";
import {
  type DesiredMachine,
  type MachinePlanFacts,
  type MachinesHook,
  principalsChangeNeedsReset,
} from "./contract.js";
import { MemoryCloud, machinesHook } from "./contract-kit.js";
import { machineStateOf, refusalBackoffMs } from "./sequencer.js";
import { SimulatedWork } from "./simulation.js";

const PROJECT = "7e0f7c3e-9a55-4d0b-8a35-0c0f4b1f2a10";
const OTHER = "0b1d9a52-4c1e-4f2a-9b53-6f1f0f6f7e21";

/** A simulated Work over an in-memory cloud and a plan a test writes. */
function setup(
  plan: (facts: MachinePlanFacts) => readonly DesiredMachine[],
  options: {
    stoppable?: boolean;
    bootSeconds?: number;
    hook?: Partial<MachinesHook>;
  } = {},
) {
  const cloud = new MemoryCloud();
  const hook = {
    ...machinesHook({
      plan: async (facts) => plan(facts),
      provisioner: cloud.provisioner({ stoppable: options.stoppable ?? true }),
    }),
    ...options.hook,
  };
  const sim = new SimulatedWork({
    hook,
    bootSeconds: options.bootSeconds ?? 60,
  });
  /** Pass, let time go by, until a pass changes nothing. */
  const settle = async () => {
    const settled = await sim.settle();
    expect(settled.quiet, JSON.stringify(settled.passes.at(-1))).toBe(true);
  };
  const verbs = (verb: string, name?: string) =>
    sim.calls.filter(
      (call) => call.verb === verb && (!name || call.name === name),
    );
  return { cloud, sim, settle, verbs };
}

describe("the sequencer (ADR 0349)", () => {
  it("gives a solo operator a machine of their own from a five-line plan and no directory", async () => {
    const { sim, cloud, settle } = setup(({ people }) =>
      people
        .filter((person) => person.active)
        .map((person) => ({
          name: `desk-${person.id}`,
          for: [{ user: person.id }],
        })),
    );
    sim.people = [
      {
        id: "ada",
        email: "ada@example.com",
        name: "Ada",
        active: true,
        administrator: true,
        roles: {},
      },
    ];
    await settle();
    expect(sim.machine("desk-ada")).toMatchObject({
      managed: true,
      state: "serving",
      for: [{ user: "ada" }],
    });
    expect(cloud.alive()).toHaveLength(1);
    // Her chat lands on it; nobody else's does.
    const hers = sim.addWork({ project: PROJECT, user: "ada" });
    const theirs = sim.addWork({ project: PROJECT, user: "grace" });
    expect(sim.placedOn(hers.id)).toBe("desk-ada");
    expect(sim.placedOn(theirs.id)).toBeUndefined();
  });

  it("records its intent first and repeats create with one key until it answers a ref", async () => {
    const answers: unknown[] = [];
    const requests: Array<{ code: string; key: string; pool?: string }> = [];
    let pool = "before";
    const { sim, cloud } = setup(
      () => [{ name: "build-1", labels: { pool } }],
      {
        hook: {
          create: async (request) => {
            requests.push({
              code: request.enrollment.code,
              key: request.enrollment.idempotencyKey,
              pool: request.labels.pool,
            });
            // The platform is slow, then throws, then answers.
            if (requests.length === 1) return { pending: true };
            if (requests.length === 2)
              throw new Error("the platform timed out");
            const answer = await cloudCreate(request);
            answers.push(answer);
            return answer;
          },
        },
      },
    );
    const cloudCreate = cloud.provisioner().create;
    await sim.pass();
    expect(sim.machine("build-1")).toMatchObject({
      state: "starting",
      ref: null,
    });
    pool = "after";
    await sim.pass();
    expect(sim.machine("build-1")?.lastError).toMatchObject({
      verb: "create",
      message: "create threw: the platform timed out",
    });
    await sim.pass();
    expect(new Set(requests.map((request) => request.key)).size).toBe(1);
    expect(new Set(requests.map((request) => request.code)).size).toBe(1);
    expect(requests.map((request) => request.pool)).toEqual([
      "before",
      "before",
      "before",
    ]);
    expect(cloud.alive()).toHaveLength(1);
    expect(sim.machine("build-1")).toMatchObject({
      ref: "memory-1",
      lastError: null,
    });
    expect(sim.events.map((event) => event.kind)).toEqual(["machine.created"]);
    await sim.pass();
    expect(sim.machine("build-1")?.labels.pool).toBe("after");
  });

  it("makes one machine when create's answer is lost on its way back", async () => {
    const { sim, cloud, settle, verbs } = setup(() => [{ name: "build-1" }]);
    sim.loseNextCreateAnswer();
    await sim.pass();
    expect(sim.machine("build-1")).toMatchObject({
      state: "starting",
      ref: null,
    });
    await settle();
    const creates = verbs("create");
    expect(creates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(creates.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(cloud.machines).toHaveLength(1);
    expect(sim.machine("build-1")).toMatchObject({
      state: "serving",
      ref: "memory-1",
    });
  });

  it("withdraws a refused create, shows why, and asks again later under a new enrollment", async () => {
    const { sim, cloud, verbs } = setup(() => [{ name: "build-1" }]);
    cloud.refusals.push("InsufficientInstanceCapacity");
    await sim.pass();
    expect(sim.machine("build-1")).toMatchObject({
      state: "starting",
      ref: null,
      lastError: {
        verb: "create",
        message: "Its platform refused: InsufficientInstanceCapacity",
      },
    });
    // Not at once: one refused create a pass would never end.
    await sim.pass();
    expect(verbs("create")).toHaveLength(1);
    expect(sim.machine("build-1")?.notice).toContain("Work asks again in 1");
    sim.advance({ seconds: 61 });
    await sim.pass();
    const creates = verbs("create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.idempotencyKey).not.toBe(creates[0]?.idempotencyKey);
    expect(sim.machine("build-1")).toMatchObject({ ref: "memory-1" });
    expect(refusalBackoffMs(1)).toBe(60_000);
    expect(refusalBackoffMs(3)).toBe(4 * 60_000);
    expect(refusalBackoffMs(20)).toBe(30 * 60_000);
  });

  it("drains a machine the plan dropped, then destroys and forgets it", async () => {
    let wanted = true;
    const { sim, cloud, settle, verbs } = setup(() =>
      wanted ? [{ name: "review-1", for: [{ project: PROJECT }] }] : [],
    );
    await settle();
    const work = sim.addWork({ project: PROJECT });
    expect(sim.placedOn(work.id)).toBe("review-1");

    wanted = false;
    await sim.pass();
    // It holds live work: no new work, no destroy.
    expect(sim.machine("review-1")).toMatchObject({ state: "draining" });
    expect(sim.machine("review-1")?.notice).toContain(
      "destroyed once its live workspace is given back",
    );
    expect(verbs("destroy")).toHaveLength(0);
    const second = sim.addWork({ project: PROJECT });
    expect(sim.placedOn(second.id)).toBeUndefined();
    sim.finishWork(second.id);

    sim.finishWork(work.id);
    await settle();
    expect(sim.machine("review-1")).toBeUndefined();
    expect(cloud.alive()).toHaveLength(0);
    expect(sim.events.map((event) => event.kind)).toEqual([
      "machine.created",
      "machine.connected",
      "machine.released",
      "machine.destroyed",
    ]);
  });

  it("keeps a dropped machine the plan names again before it went", async () => {
    let wanted = true;
    const { sim, settle, verbs } = setup(() =>
      wanted ? [{ name: "review-1", for: [{ project: PROJECT }] }] : [],
    );
    await settle();
    const work = sim.addWork({ project: PROJECT });
    wanted = false;
    await sim.pass();
    expect(sim.machine("review-1")?.state).toBe("draining");
    wanted = true;
    await sim.pass();
    expect(sim.machine("review-1")).toMatchObject({
      state: "serving",
      notice: null,
    });
    sim.finishWork(work.id);
    await settle();
    expect(verbs("destroy")).toHaveLength(0);
  });

  it("stops a machine only once it holds no live work, and starts it for waiting work, which waits and then runs", async () => {
    // Idle for five minutes: stopped, disk kept. Waiting work: running.
    const { sim, cloud, settle, verbs } = setup(({ machines, work, now }) => {
      const machine = machines.find((entry) => entry.name === "desk-ada");
      const idleMinutes = machine?.idleSince
        ? (Date.parse(now) - Date.parse(machine.idleSince)) / 60_000
        : 0;
      const needed = work.some((entry) => entry.user === "ada");
      const stopped =
        !needed &&
        (machine?.state === "stopped" ||
          machine?.state === "stopping" ||
          idleMinutes >= 5);
      return [
        {
          name: "desk-ada",
          for: [{ user: "ada" }],
          state: stopped ? "stopped" : "running",
          reason: stopped ? "Stopped after five idle minutes" : "Ada's desk",
        },
      ];
    });
    await settle();
    const chat = sim.addWork({ project: PROJECT, user: "ada" });
    sim.advance({ minutes: 30 });
    await sim.pass();
    // Thirty minutes at work is not idle.
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "serving",
      idleSince: null,
    });
    expect(verbs("stop")).toHaveLength(0);

    sim.finishWork(chat.id);
    sim.advance({ minutes: 6 });
    await settle();
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "stopped",
      reason: "Stopped after five idle minutes",
    });
    expect(cloud.machines[0]).toMatchObject({
      state: "stopped",
      ref: "memory-1",
    });
    expect(sim.events.at(-1)?.kind).toBe("machine.stopped");

    // A stopped machine offers no capacity: her next chat waits, the plan
    // hears it, and the same machine comes back.
    const next = sim.addWork({ project: PROJECT, user: "ada" });
    expect(sim.placedOn(next.id)).toBeUndefined();
    await sim.pass();
    expect(sim.machine("desk-ada")?.state).toBe("resuming");
    expect(sim.startingFor(next.id)).toEqual({
      name: "desk-ada",
      state: "resuming",
    });
    expect(cloud.machines[0]?.state).toBe("running");
    sim.advance({ seconds: 61 });
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "serving",
      ref: "memory-1",
    });
    expect(sim.placedOn(next.id)).toBe("desk-ada");
    expect(sim.events.at(-1)?.kind).toBe("machine.started");
    // One machine, never made again.
    expect(verbs("create")).toHaveLength(1);
    expect(cloud.machines).toHaveLength(1);
  });

  it("says why a machine cannot stop yet instead of stopping it under live work", async () => {
    let state: "running" | "stopped" = "running";
    const { sim, settle, verbs } = setup(() => [
      { name: "desk-ada", for: [{ user: "ada" }], state },
    ]);
    await settle();
    const chat = sim.addWork({ project: PROJECT, user: "ada" });
    state = "stopped";
    await sim.pass();
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "serving",
      notice:
        "The plan wants it stopped. It stops once its live workspace is given back.",
    });
    expect(verbs("stop")).toHaveLength(0);
    sim.finishWork(chat.id);
    await settle();
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "stopped",
      notice: null,
    });
  });

  it("never stops a machine when the hook has no stop", async () => {
    const { sim, settle } = setup(
      () => [{ name: "desk-ada", for: [{ user: "ada" }], state: "stopped" }],
      { stoppable: false },
    );
    await settle();
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "serving",
      notice:
        "The plan wants it stopped, but the machines hook has no stop: it keeps running.",
    });
  });

  it("replaces a stopped machine whose start says it is gone", async () => {
    let state: "running" | "stopped" = "running";
    const { sim, cloud, settle, verbs } = setup(() => [
      { name: "desk-ada", for: [{ user: "ada" }], state },
    ]);
    await settle();
    state = "stopped";
    await settle();
    expect(sim.machine("desk-ada")?.state).toBe("stopped");
    // Its instance was removed behind Work's back.
    cloud.kill("memory-1");
    state = "running";
    await settle();
    expect(verbs("start")).toHaveLength(1);
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "serving",
      ref: "memory-2",
    });
    const creates = verbs("create", "desk-ada");
    expect(new Set(creates.map((call) => call.idempotencyKey)).size).toBe(2);
    expect(sim.events.map((event) => event.kind)).toContain("machine.lost");
  });

  it("retires a lost machine's work at once and replaces it under a new enrollment; its chats continue there", async () => {
    const { sim, cloud, settle, verbs } = setup(() => [
      { name: "desk-ada", for: [{ user: "ada" }], lostAfterMinutes: 3 },
    ]);
    await settle();
    const chat = sim.addWork({ project: PROJECT, user: "ada" });
    expect(sim.placedOn(chat.id)).toBe("desk-ada");

    sim.lose("desk-ada");
    cloud.kill("memory-1");
    sim.advance({ minutes: 1 });
    await sim.pass();
    // Unreachable is not lost: nothing is retired yet. Its platform says it
    // is gone, though, so Work does not wait out the limit.
    expect(sim.events.map((event) => event.kind)).toContain("machine.lost");
    await settle();
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "serving",
      ref: "memory-2",
    });
    // No operator call: her chat runs on the replacement.
    expect(sim.placedOn(chat.id)).toBe("desk-ada");
    const creates = verbs("create", "desk-ada");
    expect(new Set(creates.map((call) => call.idempotencyKey)).size).toBe(2);
    expect(verbs("destroy", "desk-ada").at(-1)).toMatchObject({
      ref: "memory-1",
      answer: { done: true },
    });
  });

  it("waits out the loss limit when the platform cannot say, and keeps a machine that calls again", async () => {
    const { sim, settle, verbs } = setup(
      () => [{ name: "desk-ada", for: [{ user: "ada" }], lostAfterMinutes: 4 }],
      { hook: { describe: async () => ({ state: "unknown" as const }) } },
    );
    await settle();
    sim.lose("desk-ada");
    sim.advance({ minutes: 3 });
    await sim.pass();
    expect(sim.machine("desk-ada")?.state).toBe("unreachable");
    // A short network fault: it calls again and nothing was lost.
    sim.revive("desk-ada");
    await sim.pass();
    expect(sim.machine("desk-ada")?.state).toBe("serving");
    expect(verbs("destroy")).toHaveLength(0);

    sim.lose("desk-ada");
    sim.advance({ minutes: 5 });
    expect(sim.machine("desk-ada")?.state).toBe("lost");
    await settle();
    expect(verbs("destroy").length).toBeGreaterThan(0);
    expect(sim.machine("desk-ada")?.state).toBe("serving");
  });

  it("never calls a machine an operator disabled lost: its work waits for it", async () => {
    const { sim, settle, verbs } = setup(() => [
      { name: "desk-ada", for: [{ user: "ada" }], lostAfterMinutes: 2 },
    ]);
    await settle();
    const chat = sim.addWork({ project: PROJECT, user: "ada" });
    sim.setDisabled("desk-ada", true);
    sim.advance({ minutes: 30 });
    await sim.pass();
    expect(sim.machine("desk-ada")).toMatchObject({
      state: "disabled",
      holding: { workspaces: 1 },
    });
    expect(verbs("destroy")).toHaveLength(0);
    expect(sim.events.map((event) => event.kind)).not.toContain("machine.lost");
    sim.setDisabled("desk-ada", false);
    sim.advance({ seconds: 5 });
    expect(sim.machine("desk-ada")?.state).toBe("serving");
    expect(sim.placedOn(chat.id)).toBe("desk-ada");
  });

  it("resets a machine before someone new may use it, and not when its principals only narrow", async () => {
    let principals = [{ user: "ada" }, { user: "grace" }];
    const { sim, settle } = setup(() => [
      { name: "shared-1", for: principals, trusted: true },
    ]);
    await settle();
    const chat = sim.addWork({ project: PROJECT, user: "grace" });

    // Narrowing: nobody new, no reset.
    principals = [{ user: "grace" }];
    await sim.pass();
    expect(sim.machine("shared-1")?.for).toEqual([{ user: "grace" }]);
    expect(sim.resetsOf("shared-1")).toBe(0);

    // Someone new: it keeps serving Grace's chat under the old principals,
    // takes nothing new, and is reset once that chat gave its workspace back.
    principals = [{ user: "edsger" }];
    await sim.pass();
    expect(sim.machine("shared-1")).toMatchObject({ for: [{ user: "grace" }] });
    expect(sim.machine("shared-1")?.notice).toContain(
      "is reset once its live workspace is given back",
    );
    const early = sim.addWork({ project: PROJECT, user: "edsger" });
    expect(sim.placedOn(early.id)).toBeUndefined();
    sim.finishWork(chat.id);
    await sim.pass();
    expect(sim.resetsOf("shared-1")).toBe(1);
    expect(sim.machine("shared-1")).toMatchObject({
      for: [{ user: "edsger" }],
      notice: null,
    });
    sim.advance({ seconds: 5 });
    expect(sim.placedOn(early.id)).toBe("shared-1");

    expect(
      principalsChangeNeedsReset({ from: null, to: [{ user: "ada" }] }),
    ).toBe(false);
    expect(
      principalsChangeNeedsReset({ from: [{ user: "ada" }], to: null }),
    ).toBe(true);
    expect(
      principalsChangeNeedsReset({
        from: [{ project: PROJECT }],
        to: [{ project: PROJECT, key: "pr-7" }],
      }),
    ).toBe(false);
    expect(
      principalsChangeNeedsReset({
        from: [{ project: PROJECT, key: "pr-7" }],
        to: [{ project: PROJECT }],
      }),
    ).toBe(true);
    // Withdrawing all access can leave the previous owner's disk behind.
    expect(principalsChangeNeedsReset({ from: [], to: null })).toBe(true);
    expect(
      principalsChangeNeedsReset({ from: [], to: [{ user: "new" }] }),
    ).toBe(true);
  });

  it("changes nothing when the plan throws, takes too long or answers something invalid, and shows the error", async () => {
    let mode: "ok" | "throw" | "invalid" | "twice" = "ok";
    const { sim, cloud, settle, verbs } = setup(() => {
      if (mode === "throw") throw new Error("the directory is down");
      if (mode === "invalid")
        return [{ name: "Not A Name", for: [{ user: "ada" }] }];
      if (mode === "twice") return [{ name: "desk-ada" }, { name: "desk-ada" }];
      return [{ name: "desk-ada", for: [{ user: "ada" }] }];
    });
    await settle();
    const calls = sim.calls.length;
    for (const [next, error] of [
      ["throw", "plan threw: the directory is down"],
      ["invalid", "plan returned something invalid (0.name:"],
      ["twice", "The plan names 'desk-ada' twice"],
    ] as const) {
      mode = next;
      const summary = await sim.pass();
      expect(summary.planError).toContain(error);
      expect(sim.planError).toContain(error);
    }
    // The machine it had keeps running; nothing was created or destroyed.
    expect(sim.calls).toHaveLength(calls);
    expect(sim.machine("desk-ada")?.state).toBe("serving");
    expect(cloud.alive()).toHaveLength(1);
    mode = "ok";
    await sim.pass();
    expect(sim.planError).toBeNull();
    expect(verbs("destroy")).toHaveLength(0);
  });

  it("never creates, stops or destroys a machine enrolled by hand; the plan may say whom it is for", async () => {
    let entry: DesiredMachine | undefined;
    const { sim, cloud, settle } = setup(() => (entry ? [entry] : []));
    sim.enrollByHand({ name: "rack-1", labels: { pool: "bench" } });
    sim.advance({ seconds: 61 });
    await settle();
    // The plan does not name it: it stays, untouched.
    expect(sim.machine("rack-1")).toMatchObject({
      managed: false,
      state: "serving",
      for: null,
    });
    entry = {
      name: "rack-1",
      for: [{ project: PROJECT }],
      labels: { pool: "bench" },
      state: "stopped",
      reason: "The bench project's machine",
    };
    await settle();
    expect(sim.machine("rack-1")).toMatchObject({
      state: "serving",
      for: [{ project: PROJECT }],
      reason: "The bench project's machine",
    });
    expect(sim.machine("rack-1")?.notice).toContain("Work never stops it");
    // Lost, it is reported and never destroyed or made again.
    sim.lose("rack-1");
    sim.advance({ minutes: 10 });
    await sim.pass();
    expect(sim.machine("rack-1")?.state).toBe("lost");
    entry = undefined;
    await sim.pass();
    expect(sim.machine("rack-1")).toBeDefined();
    expect(sim.calls).toHaveLength(0);
    expect(cloud.machines).toHaveLength(0);
  });

  it("gives each chat key a machine of its own and no other chat a place on it", async () => {
    // One machine per waiting or running keyed chat: a pull request reviewer.
    const { sim, settle } = setup(({ work, machines }) => {
      const keys = new Set([
        ...work.flatMap((entry) => (entry.key ? [entry.key] : [])),
        ...machines.flatMap((machine) =>
          machine.holding.for.flatMap((principal) =>
            "key" in principal ? [principal.key] : [],
          ),
        ),
      ]);
      return [...keys].sort().map((key) => ({
        name: `review-${key}`,
        for: [{ project: PROJECT, key }],
        labels: { pool: "review" },
      }));
    });
    const seven = sim.addWork({
      project: PROJECT,
      key: "pr-7",
      pool: { pool: "review" },
    });
    const eight = sim.addWork({
      project: PROJECT,
      key: "pr-8",
      pool: { pool: "review" },
    });
    await sim.pass();
    expect(sim.startingFor(seven.id)).toEqual({
      name: "review-pr-7",
      state: "starting",
    });
    await settle();
    expect(sim.placedOn(seven.id)).toBe("review-pr-7");
    expect(sim.placedOn(eight.id)).toBe("review-pr-8");
    // Another project's chat with the same key, and a chat with no key,
    // find no machine.
    const foreign = sim.addWork({
      project: OTHER,
      key: "pr-7",
      pool: { pool: "review" },
    });
    expect(sim.placedOn(foreign.id)).toBeUndefined();
    sim.finishWork(foreign.id);
    // Its pull request closed: its machine goes.
    sim.finishWork(seven.id);
    await settle();
    expect(sim.machine("review-pr-7")).toBeUndefined();
    expect(sim.machine("review-pr-8")?.state).toBe("serving");
  });
});

describe("machine states", () => {
  const base = {
    dropped: false,
    disabled: false,
    live: true,
    unseenForMs: 0,
    lostAfterMs: 5 * 60_000,
    startAskedForMs: null,
  };

  it("reads a machine's state from what Work stores and its worker's lease", () => {
    expect(machineStateOf({ ...base, phase: "starting", live: false })).toBe(
      "starting",
    );
    expect(machineStateOf({ ...base, phase: "running" })).toBe("serving");
    expect(machineStateOf({ ...base, phase: "running", dropped: true })).toBe(
      "draining",
    );
    expect(
      machineStateOf({
        ...base,
        phase: "running",
        live: false,
        unseenForMs: 60_000,
      }),
    ).toBe("unreachable");
    expect(
      machineStateOf({
        ...base,
        phase: "running",
        live: false,
        unseenForMs: 5 * 60_000,
      }),
    ).toBe("lost");
    // Disabled, stopped and resuming machines are unseen without being lost.
    expect(
      machineStateOf({
        ...base,
        phase: "running",
        disabled: true,
        live: false,
        unseenForMs: 60 * 60_000,
      }),
    ).toBe("disabled");
    expect(
      machineStateOf({
        ...base,
        phase: "stopped",
        live: false,
        unseenForMs: 60 * 60_000,
      }),
    ).toBe("stopped");
    expect(
      machineStateOf({
        ...base,
        phase: "resuming",
        live: false,
        unseenForMs: 60 * 60_000,
        startAskedForMs: 60_000,
      }),
    ).toBe("resuming");
    // A resumed machine that never comes back is lost after its limit and
    // the time a boot takes.
    expect(
      machineStateOf({
        ...base,
        phase: "resuming",
        live: false,
        startAskedForMs: 16 * 60_000,
      }),
    ).toBe("lost");
  });
});
