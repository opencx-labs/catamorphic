import { createHash } from "node:crypto";
import type {
  DesiredMachine,
  MachineCreateRequest,
  MachinePlanFacts,
  MachinesHook,
  MachineTarget,
  PersonFacts,
  WaitingWork,
} from "./contract.js";
import { MachinePlanSchema } from "./contract.js";
import { canonical } from "./sequencer.js";
import {
  type SimulatedCall,
  SimulatedWork,
  type SimulatedWorkOptions,
} from "./simulation.js";

/*
 * The machines hook contract kit (ADR 0347). It runs a host's hook against
 * a simulated Work with a fake clock and checks what Work relies on: names
 * are stable, the plan converges and does not flap, no machine is made
 * twice under retries or a lost answer, nothing holding live work is
 * stopped or destroyed, verbs are idempotent, and a lost machine is
 * replaced. A failure says what happened and what to change.
 */

/** A check failed. Its message says what happened and what to change. */
export class MachinesContractError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(`machines hook contract: ${check}\n${message}`);
    this.name = "MachinesContractError";
  }
}

function fail(check: string, lines: readonly string[]): never {
  throw new MachinesContractError(check, lines.join("\n"));
}

/** The provisioner half of a hook: the calls that touch the host's cloud. */
export type MachineProvisioner = Pick<
  MachinesHook,
  "create" | "destroy" | "stop" | "start" | "describe"
>;

/** A hook from a plan and a provisioner, as hosts compose them. */
export function machinesHook(args: {
  plan: MachinesHook["plan"];
  provisioner: MachineProvisioner;
  onEvent?: MachinesHook["onEvent"];
}): MachinesHook {
  return {
    plan: args.plan,
    ...args.provisioner,
    ...(args.onEvent ? { onEvent: args.onEvent } : {}),
  };
}

/** One machine in a {@link MemoryCloud}. */
export interface MemoryCloudMachine {
  ref: string;
  name: string;
  idempotencyKey: string;
  state: "running" | "stopped" | "gone";
  options: Readonly<Record<string, unknown>>;
}

/**
 * An in-memory cloud for tests of a plan: a provisioner that keeps its
 * machines in a list, honors idempotency keys, stops, starts and
 * describes. `kill` ends a machine as a cloud would (a Spot reclaim, a
 * terminated instance).
 */
export class MemoryCloud {
  readonly machines: MemoryCloudMachine[] = [];
  /** Answers `create` gives instead of making a machine, in order. */
  readonly refusals: string[] = [];
  private count = 0;

  /** Machines that still exist. */
  alive(): MemoryCloudMachine[] {
    return this.machines.filter((machine) => machine.state !== "gone");
  }

  kill(ref: string): void {
    const machine = this.machines.find((entry) => entry.ref === ref);
    if (machine) machine.state = "gone";
  }

  provisioner(options: { stoppable?: boolean } = {}): MachineProvisioner {
    const find = (target: MachineTarget) =>
      this.machines.filter(
        (machine) =>
          machine.state !== "gone" &&
          (machine.ref === target.ref ||
            (target.idempotencyKey !== null &&
              machine.idempotencyKey === target.idempotencyKey)),
      );
    const stoppable = options.stoppable ?? true;
    return {
      create: async (request) => {
        const key = request.enrollment.idempotencyKey;
        const existing = this.machines.find(
          (machine) => machine.idempotencyKey === key,
        );
        if (existing) return { ref: existing.ref };
        const refusal = this.refusals.shift();
        if (refusal) return { refused: refusal };
        this.count += 1;
        const ref = `memory-${this.count}`;
        this.machines.push({
          ref,
          name: request.name,
          idempotencyKey: key,
          state: "running",
          options: request.options,
        });
        return { ref };
      },
      destroy: async (target) => {
        for (const machine of find(target)) machine.state = "gone";
        return { done: true };
      },
      ...(stoppable
        ? {
            stop: async (target: MachineTarget) => {
              for (const machine of find(target)) machine.state = "stopped";
              return { done: true };
            },
            start: async (target: MachineTarget) => {
              const machines = find(target);
              if (machines.length === 0) return { gone: true as const };
              for (const machine of machines) machine.state = "running";
              return { done: true };
            },
          }
        : {}),
      describe: async (target) => {
        const machine = find(target)[0];
        return { state: machine ? machine.state : ("gone" as const) };
      },
    };
  }
}

/** What a provisioner check knows about the cloud behind it, when a test can say. */
export interface PlatformProbe {
  /** How many machines exist on the platform right now (running or stopped). */
  count(): Promise<number> | number;
}

function requestFor(args: {
  name: string;
  options: Readonly<Record<string, unknown>>;
  labels: Readonly<Record<string, string>>;
  generation: number;
}): MachineCreateRequest {
  const code = `wke_contract_${args.name}_${args.generation}`;
  return {
    name: args.name,
    options: args.options,
    labels: args.labels,
    enrollment: {
      controlPlaneUrl: "https://work.example.test",
      code,
      idempotencyKey: createHash("sha256").update(code).digest("hex"),
    },
  };
}

/** Repeat a verb as Work does, until it answers what `until` accepts. */
async function repeat<T>(args: {
  check: string;
  what: string;
  call: () => Promise<T>;
  until: (answer: T) => boolean;
  attempts?: number;
  between?: () => Promise<void> | void;
  hint: string;
}): Promise<T> {
  let answer = await args.call();
  for (let index = 1; index < (args.attempts ?? 20); index += 1) {
    if (args.until(answer)) return answer;
    await args.between?.();
    answer = await args.call();
  }
  if (args.until(answer)) return answer;
  return fail(args.check, [
    `${args.what} never finished: after ${args.attempts ?? 20} calls it still answered ${JSON.stringify(answer)}.`,
    args.hint,
  ]);
}

/**
 * Check a provisioner's verbs directly, as Work calls them: `create` twice
 * with one key makes one machine, `stop` and `start` (when it has them)
 * may be repeated, `destroy` may be repeated and removes a machine whose
 * create answer was lost. Pass `platform` when the test can count the
 * machines behind it, and `between` to let a fake cloud's time pass
 * between repeats.
 */
export async function checkMachineProvisioner(args: {
  provisioner: MachineProvisioner;
  /** The options a plan would give these machines. */
  options?: Readonly<Record<string, unknown>>;
  labels?: Readonly<Record<string, string>>;
  platform?: PlatformProbe;
  /** Runs between repeats of a verb: move a fake cloud's clock here. */
  between?: () => Promise<void> | void;
  /** The name the check's machine gets. */
  name?: string;
}): Promise<void> {
  const { provisioner, platform } = args;
  const name = args.name ?? "contract-check-1";
  const options = args.options ?? {};
  const labels = args.labels ?? {};
  const between = args.between ?? (() => {});
  const before = platform ? await platform.count() : 0;
  const request = requestFor({ name, options, labels, generation: 1 });

  // create: repeated with one key until it answers a ref.
  const created = await repeat({
    check: "create answers a ref",
    what: "create",
    call: () => provisioner.create(request),
    until: (answer) => !("pending" in answer),
    between,
    hint: "Answer { pending: true } only while the machine is on its way, then { ref } with the platform's id. Answer { refused: reason } when the platform made nothing.",
  });
  if ("refused" in created)
    fail("create answers a ref", [
      `create refused: ${created.refused}.`,
      "The check needs one machine made: give it options and a fake cloud that can make one.",
    ]);
  if (!("ref" in created)) return;
  const again = await provisioner.create(request);
  if (!("ref" in again) || again.ref !== created.ref)
    fail("create is idempotent", [
      `Called twice with the same idempotencyKey, create answered ${JSON.stringify(created)} and then ${JSON.stringify(again)}.`,
      "Work repeats create with one key until it hears a ref, and after a lost answer. Hand enrollment.idempotencyKey to the platform as its idempotency token (EC2 ClientToken, a unique name or label elsewhere), and when a machine with that key exists, return its ref instead of making another.",
    ]);
  if (platform && (await platform.count()) !== before + 1)
    fail("create is idempotent", [
      `After two creates with one idempotencyKey the platform has ${(await platform.count()) - before} machine(s); it must have exactly 1.`,
      "Hand enrollment.idempotencyKey to the platform as its idempotency token so a repeated create makes nothing new.",
    ]);
  const target: MachineTarget = {
    name,
    ref: created.ref,
    idempotencyKey: request.enrollment.idempotencyKey,
    options,
    labels,
  };

  if (provisioner.describe) {
    const described = await provisioner.describe(target);
    if (described.state === "gone" || described.state === "stopped")
      fail("describe sees a machine create made", [
        `Right after create, describe answered ${JSON.stringify(described)} for ref ${created.ref}.`,
        'Answer "running" for a machine that exists and is not stopped (starting counts), "unknown" when the platform cannot say, and "gone" only when it certainly no longer exists: Work treats "gone" as a loss and makes the machine again.',
      ]);
  }

  const requestedAt = new Date().toISOString();
  const { stop, start } = provisioner;
  if (stop && !start)
    fail("stop comes with start", [
      "The provisioner has stop but no start.",
      "A machine Work stopped could never serve again. Add start, or remove stop so no plan can stop a machine.",
    ]);
  if (stop && start) {
    const stopped = await repeat({
      check: "stop finishes",
      what: "stop",
      call: () => stop({ ...target, requestedAt }),
      until: (answer) => answer.done,
      between,
      hint: "Answer { done: false } while the machine is stopping and { done: true } once it is stopped with its disk kept.",
    });
    const stoppedAgain = await stop({ ...target, requestedAt });
    if (!stopped.done || !stoppedAgain.done)
      fail("stop is idempotent", [
        `stop on a machine that is already stopped answered ${JSON.stringify(stoppedAgain)}.`,
        "Work repeats stop until it is done and may repeat it after: stopping a stopped machine answers { done: true } and changes nothing.",
      ]);
    if (provisioner.describe) {
      const described = await provisioner.describe(target);
      if (described.state === "gone")
        fail("stop keeps the machine", [
          'After stop, describe answered "gone".',
          "stop must keep the machine and its disk (worker identity, sign-ins, volumes, caches) so start brings the same machine back. Do not terminate on stop, and do not offer stop for machines that cannot be stopped (EC2 Spot without a persistent request).",
        ]);
    }
    const started = await repeat({
      check: "start finishes",
      what: "start",
      call: () => start({ ...target, requestedAt }),
      until: (answer) => "gone" in answer || answer.done,
      between,
      hint: "Answer { done: false } while the machine is starting, { done: true } once the platform runs it, and { gone: true } when it no longer exists.",
    });
    if ("gone" in started)
      fail("start brings back a stopped machine", [
        "start answered { gone: true } for a machine stop had just stopped.",
        "stop must keep the machine and its disk. Answer { gone: true } from start only when the machine no longer exists.",
      ]);
    const startedAgain = await start({ ...target, requestedAt });
    if ("gone" in startedAgain || !startedAgain.done)
      fail("start is idempotent", [
        `start on a machine that is already running answered ${JSON.stringify(startedAgain)}.`,
        "Starting a running machine answers { done: true } and changes nothing.",
      ]);
  }

  // destroy: repeated until done, then harmless.
  await repeat({
    check: "destroy finishes",
    what: "destroy",
    call: () => provisioner.destroy({ ...target, requestedAt }),
    until: (answer) => answer.done,
    attempts: 60,
    between,
    hint: "Answer { done: false } while the machine is going and { done: true } once none with this ref, key or name is left. Work forgets the machine only then.",
  });
  const destroyedAgain = await provisioner.destroy({ ...target, requestedAt });
  if (!destroyedAgain.done)
    fail("destroy is idempotent", [
      `destroy on a machine that is already gone answered ${JSON.stringify(destroyedAgain)}.`,
      "Destroying a machine that no longer exists answers { done: true }.",
    ]);
  if (platform && (await platform.count()) !== before)
    fail("destroy removes the machine", [
      `After destroy answered done, the platform still has ${(await platform.count()) - before} machine(s) from this check.`,
      "Answer { done: true } only once the machine is gone.",
    ]);
  if (start) {
    const gone = await start({ ...target, requestedAt });
    if (!("gone" in gone))
      fail("start says when a machine is gone", [
        `start on a destroyed machine answered ${JSON.stringify(gone)}.`,
        "Answer { gone: true } when the machine no longer exists: Work then treats it as lost and makes it again, instead of waiting for a worker that never connects.",
      ]);
  }

  // A create whose answer was lost: destroy must find it without a ref.
  const orphan = requestFor({ name, options, labels, generation: 2 });
  const made = await repeat({
    check: "create answers a ref",
    what: "create",
    call: () => provisioner.create(orphan),
    until: (answer) => !("pending" in answer),
    between,
    hint: "Answer { ref } once the machine exists.",
  });
  if (!("ref" in made)) return;
  if (made.ref === created.ref)
    fail("a new enrollment makes a new machine", [
      `A create with a new idempotencyKey answered the destroyed machine's ref ${made.ref}.`,
      "Key machines by enrollment.idempotencyKey, never by name alone: a later machine reuses the name of one that is gone.",
    ]);
  await repeat({
    check: "destroy finds a machine whose ref was never recorded",
    what: "destroy with ref: null",
    call: () =>
      provisioner.destroy({
        name,
        ref: null,
        idempotencyKey: orphan.enrollment.idempotencyKey,
        options,
        labels,
        requestedAt,
      }),
    until: (answer) => answer.done,
    attempts: 60,
    between,
    hint: "When ref is null, find the machine by idempotencyKey (and by name), destroy it, and answer { done: true } only once nothing is left.",
  });
  if (platform && (await platform.count()) !== before)
    fail("destroy finds a machine whose ref was never recorded", [
      `After destroy with ref: null answered done, the platform still has ${(await platform.count()) - before} machine(s).`,
      "A create whose answer was lost leaves a machine Work knows only by its idempotencyKey and name. destroy must look it up by those and remove it.",
    ]);
}

/** Facts a plan is checked with. */
export interface ContractFacts {
  people?: readonly PersonFacts[];
  /** Work that waits when the check starts. */
  work?: ReadonlyArray<Partial<Omit<WaitingWork, "id">> & { project: string }>;
}

function names(plan: readonly DesiredMachine[]): string[] {
  return plan.map((machine) => machine.name).sort();
}

function creates(calls: readonly SimulatedCall[]): SimulatedCall[] {
  return calls.filter((call) => call.verb === "create");
}

/**
 * Check a whole hook against a simulated Work. Give it facts under which
 * the plan wants at least one machine (people, waiting work). Throws a
 * {@link MachinesContractError} that reads as an instruction.
 */
export async function checkMachinesHook(args: {
  hook: MachinesHook;
  facts?: ContractFacts;
  /** Runs whenever the simulated clock moves: move a fake cloud's clock too. */
  onAdvance?: (now: string) => Promise<void> | void;
  /** End a machine on the platform as a cloud would, so its loss is real. */
  kill?: (machine: {
    name: string;
    ref: string | null;
  }) => Promise<void> | void;
  simulation?: Omit<SimulatedWorkOptions, "hook" | "people">;
}): Promise<void> {
  const { hook } = args;
  const sim = new SimulatedWork({
    ...args.simulation,
    hook,
    ...(args.facts?.people ? { people: args.facts.people } : {}),
  });
  for (const work of args.facts?.work ?? []) sim.addWork(work);
  const advance = async (time: { seconds?: number; minutes?: number }) => {
    sim.advance(time);
    await args.onAdvance?.(sim.now);
  };

  // 1. The same facts give the same plan.
  const facts: MachinePlanFacts = {
    now: sim.now,
    work: [...sim.waiting()],
    machines: sim.facts(),
    people: sim.people,
  };
  const first = MachinePlanSchema.safeParse(await hook.plan(facts));
  const second = MachinePlanSchema.safeParse(await hook.plan(facts));
  if (!first.success || !second.success) {
    const issue = (first.success ? second : first).error?.issues[0];
    fail("plan returns valid machines", [
      `plan returned something Work cannot use${issue ? `: ${issue.path.join(".") || "result"}: ${issue.message}` : ""}.`,
      "Return an array of { name, for?, labels?, state?, options?, trusted?, lostAfterMinutes?, reason? }. Names are lowercase letters, digits and dashes, at most 63 characters, each once.",
    ]);
  }
  if (canonical(first.data) !== canonical(second.data))
    fail("plan is stable", [
      `Asked twice with the same facts, plan returned [${names(first.data).join(", ")}] and then [${names(second.data).join(", ")}] (or the same names with different settings).`,
      "Work matches machines by name: a name that changes is a machine destroyed and another created. Derive every name from something that lasts (a user id, a project id, a chat key, a slot number), never from the time, a counter or randomness.",
    ]);
  if (first.data.length === 0)
    fail("the check has something to check", [
      "With the facts given, plan wants no machine.",
      "Pass facts under which it wants at least one: people with the roles it looks for, or waiting work it serves (checkMachinesHook({ hook, facts: { people, work } })).",
    ]);

  // 2. A lost create answer never makes a second machine.
  sim.loseNextCreateAnswer();
  await sim.pass();
  await advance({ seconds: 10 });
  await sim.pass();
  const byName = new Map<string, SimulatedCall[]>();
  for (const call of creates(sim.calls))
    byName.set(call.name, [...(byName.get(call.name) ?? []), call]);
  for (const [name, calls] of byName) {
    const keys = new Set(calls.map((call) => call.idempotencyKey));
    const refs = new Set(
      calls.flatMap((call) => {
        const answer = call.answer;
        return answer && typeof answer === "object" && "ref" in answer
          ? [String(answer.ref)]
          : [];
      }),
    );
    if (keys.size === 1 && refs.size > 1)
      fail("no machine is made twice", [
        `create was repeated for '${name}' with one idempotencyKey (its first answer was lost) and answered different refs: ${[...refs].join(", ")}.`,
        "The platform now has two machines for one name. Hand enrollment.idempotencyKey to the platform as its idempotency token, and return the existing machine's ref when one was already made with that key.",
      ]);
  }

  // 3. The plan settles and then stays put.
  const settled = await settleWith({ sim, advance, limit: 40 });
  if (!settled)
    fail("plan converges", [
      `After 40 passes over ${Math.round((40 * 30) / 60)} simulated minutes, with no fact changed from outside, the hook was still being asked to change machines. The latest calls: ${recent(sim.calls)}.`,
      "A plan must settle: once the machines it asked for exist, it asks for the same set again. Look for a name that depends on a machine's own state (so reaching that state renames it), or a machine dropped because of a fact the drop itself changes back.",
    ]);
  const settledAt = sim.calls.length;
  for (let index = 0; index < 5; index += 1) {
    await advance({ seconds: 10 });
    await sim.pass();
  }
  const after = sim.calls
    .slice(settledAt)
    .filter((call) => call.verb === "create" || call.verb === "destroy");
  if (after.length > 0)
    fail("plan does not flap", [
      `Nothing changed, yet within a simulated minute the plan had machines made or destroyed: ${recent(after)}.`,
      "Keep a machine while the reason for it holds. If the plan drops machines that are idle, give them an idle time of minutes, not seconds, and measure it from the machine's own idleSince.",
    ]);
  for (const [name, calls] of groupByName(creates(sim.calls))) {
    const keys = new Set(calls.map((call) => call.idempotencyKey));
    if (keys.size > 1)
      fail("plan does not flap", [
        `'${name}' was created ${keys.size} times (under ${keys.size} enrollments) while nothing changed from outside.`,
        'The plan dropped a machine and asked for it again. Decide from facts that stay the same while a machine starts: a machine in state "starting" is on its way, not missing.',
      ]);
  }

  // 4. Nothing holding live work is stopped or destroyed out of band.
  const serving = sim
    .facts()
    .filter((machine) => machine.managed && machine.state === "serving");
  if (hook.describe) {
    const describe = hook.describe.bind(hook);
    for (const machine of serving) {
      if (machine.holding.workspaces === 0) continue;
      const described = await describe({
        name: machine.name,
        ref: machine.ref,
        idempotencyKey: null,
        options: machine.options,
        labels: machine.labels,
      });
      if (described.state === "gone" || described.state === "stopped")
        fail("nothing holding live work is stopped or destroyed", [
          `'${machine.name}' holds ${machine.holding.workspaces} live workspace(s) and Work never asked to stop or destroy it, yet describe says it is ${described.state}.`,
          "Something in the hook removed it: a sweep by tag or name prefix, a time limit enforced inside create or plan. Only stop and destroy end machines, and Work calls them once a machine holds no live work (or is lost).",
        ]);
    }
  }

  // 5. A lost machine is replaced, under a new enrollment.
  const victim = serving[0];
  if (victim) {
    const before = creates(sim.calls).filter(
      (call) => call.name === victim.name,
    );
    const oldKey = before[before.length - 1]?.idempotencyKey ?? null;
    sim.lose(victim.name);
    await args.kill?.({ name: victim.name, ref: victim.ref });
    for (let index = 0; index < 30; index += 1) {
      await advance({ minutes: 1 });
      await sim.pass();
      const now = sim.machine(victim.name);
      if (now?.state === "serving" && now.ref !== victim.ref) break;
      if (!now && !(await wants({ hook, sim, name: victim.name }))) break;
    }
    const destroyed = sim.calls.some(
      (call) =>
        call.verb === "destroy" &&
        call.name === victim.name &&
        answerDone(call.answer),
    );
    if (!destroyed)
      fail("a lost machine is destroyed", [
        `'${victim.name}' stopped calling and was lost, but destroy never answered { done: true } for it in 30 simulated minutes. Its latest answers: ${recent(sim.calls.filter((call) => call.verb === "destroy" && call.name === victim.name))}.`,
        "Work asks destroy for a lost machine until it is done, so nothing is left running on the platform. Answer { done: true } once the machine is gone, including when it is gone already.",
      ]);
    if (await wants({ hook, sim, name: victim.name })) {
      const remade = creates(sim.calls).filter(
        (call) => call.name === victim.name && call.idempotencyKey !== oldKey,
      );
      const now = sim.machine(victim.name);
      if (remade.length === 0 || now?.state !== "serving")
        fail("a lost machine is replaced", [
          `The plan still names '${victim.name}' after it was lost, but 30 simulated minutes later it is ${now ? now.state : "not there"}${now?.lastError ? ` (${now.lastError.verb}: ${now.lastError.message})` : ""}.`,
          "Work destroys what is left of a lost machine and creates it again under a new enrollment and idempotencyKey. create must make a new machine for the new key although the name is the same, and destroy must not answer done before the old one is gone.",
        ]);
      const refs = new Set(
        remade.flatMap((call) => {
          const answer = call.answer;
          return answer && typeof answer === "object" && "ref" in answer
            ? [String(answer.ref)]
            : [];
        }),
      );
      if (victim.ref !== null && refs.has(victim.ref))
        fail("a lost machine is replaced", [
          `The replacement for '${victim.name}' got the lost machine's ref ${victim.ref} back.`,
          "Key a create by enrollment.idempotencyKey, not by name: a new key is a new machine.",
        ]);
    }
  }
}

async function wants(args: {
  hook: MachinesHook;
  sim: SimulatedWork;
  name: string;
}): Promise<boolean> {
  const plan = MachinePlanSchema.safeParse(
    await args.hook.plan({
      now: args.sim.now,
      work: [...args.sim.waiting()],
      machines: args.sim.facts(),
      people: args.sim.people,
    }),
  );
  return (
    plan.success && plan.data.some((machine) => machine.name === args.name)
  );
}

async function settleWith(args: {
  sim: SimulatedWork;
  advance: (time: { seconds?: number }) => Promise<void>;
  limit: number;
}): Promise<boolean> {
  for (let index = 0; index < args.limit; index += 1) {
    const { quiet } = await args.sim.settle({ limit: 1 });
    if (quiet) return true;
    await args.advance({ seconds: 30 });
  }
  return false;
}

function groupByName(
  calls: readonly SimulatedCall[],
): Map<string, SimulatedCall[]> {
  const grouped = new Map<string, SimulatedCall[]>();
  for (const call of calls)
    grouped.set(call.name, [...(grouped.get(call.name) ?? []), call]);
  return grouped;
}

function answerDone(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    "done" in answer &&
    answer.done === true
  );
}

function recent(calls: readonly SimulatedCall[]): string {
  if (calls.length === 0) return "none";
  return calls
    .slice(-6)
    .map(
      (call) =>
        `${call.verb} ${call.name} -> ${call.error ? `threw ${call.error}` : JSON.stringify(call.answer)}`,
    )
    .join("; ");
}
