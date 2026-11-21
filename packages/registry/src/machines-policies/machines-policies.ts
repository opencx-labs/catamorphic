import { createHash } from "node:crypto";
import type {
  DesiredMachine,
  MachineFacts,
  MachinePlanFacts,
  MachinePrincipal,
  MachinesHook,
  PersonFacts,
  WaitingWork,
} from "@catamorphic/work-server";

/*
 * Small policies for a machines hook's `plan` (ADR 0347): host code from
 * the `machines-policies` pack, yours to change. Policy is code: Work asks
 * `plan` for the machines that should exist and works out the difference.
 * Each policy here takes the facts and the machines planned so far and
 * returns the machines planned after it; `compose` runs them in order:
 *
 *   plan: compose(
 *     onePerPerson({ prefix: "desk", role: { project, role: "engineer" } }),
 *     onDemand({ prefix: "ci", max: 4, serves: (work) => work.pool.pool === "ci" }),
 *     stopWhenIdle({ minutes: 30 }),
 *     destroyStoppedAfter({ days: 14 }),
 *     replaceNeverEnrolled({ minutes: 20 }),
 *   )
 *
 * Names come from things that last (a user id, a chat key, a slot number),
 * so the same facts always give the same machines.
 */

export type MachinePolicy = (args: {
  facts: MachinePlanFacts;
  /** The machines planned by the policies before this one. */
  machines: readonly DesiredMachine[];
}) => readonly DesiredMachine[] | Promise<readonly DesiredMachine[]>;

/** Run policies in order; the last one's machines are the plan. */
export function compose(
  ...policies: readonly MachinePolicy[]
): MachinesHook["plan"] {
  return async (facts) => {
    let machines: readonly DesiredMachine[] = [];
    for (const policy of policies) machines = await policy({ facts, machines });
    const seen = new Set<string>();
    for (const machine of machines) {
      if (seen.has(machine.name))
        throw new Error(
          `Two policies plan a machine named '${machine.name}': give each policy its own prefix`,
        );
      seen.add(machine.name);
    }
    return machines;
  };
}

/** What a policy may set on the machines it plans. */
export interface MachineShape {
  labels?: Readonly<Record<string, string>>;
  options?: Readonly<Record<string, unknown>>;
  trusted?: boolean;
  lostAfterMinutes?: number;
}

/**
 * A stable name part from an id or key: lowercase letters, digits and
 * dashes. One that had to change, or is long, also carries a short hash,
 * so two ids never share a name.
 */
export function nameOf(value: string, limit = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === value && slug.length <= limit && slug.length > 0) return slug;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  const head = slug.slice(0, limit - 9).replace(/-+$/g, "");
  return head ? `${head}-${hash}` : hash;
}

/** Whether a machine with these labels and principals would take this work. */
export function takes(
  machine: {
    labels?: Readonly<Record<string, string>>;
    for?: readonly MachinePrincipal[] | null;
  },
  work: WaitingWork,
): boolean {
  const labels: Record<string, string> = { ...machine.labels, plane: "worker" };
  if (!Object.entries(work.pool).every(([key, value]) => labels[key] === value))
    return false;
  if (machine.for === undefined || machine.for === null) return true;
  return machine.for.some((principal) => {
    if ("user" in principal) return work.user === principal.user;
    if (work.user !== null || principal.project !== work.project) return false;
    return !("key" in principal) || principal.key === work.key;
  });
}

function minutesSince(now: string, since: string | null): number {
  return since === null ? 0 : (Date.parse(now) - Date.parse(since)) / 60_000;
}

/**
 * One machine of their own for each person: everyone `people` returns, or
 * everyone active who holds `role` in a project. Named `<prefix>-<user>`.
 */
export function onePerPerson(
  config: {
    prefix: string;
    /** The people who get one; left out, everyone `role` names. */
    people?: (facts: MachinePlanFacts) => readonly PersonFacts[];
    /** Everyone active with this role in this project. */
    role?: { project: string; role: string };
    reason?: (person: PersonFacts) => string;
  } & MachineShape,
): MachinePolicy {
  return ({ facts, machines }) => {
    const { role } = config;
    const people = config.people
      ? config.people(facts)
      : facts.people.filter(
          (person) =>
            role !== undefined &&
            (person.roles[role.project] ?? []).includes(role.role),
        );
    return [
      ...machines,
      ...people
        .filter((person) => person.active)
        .map((person) => ({
          name: `${config.prefix}-${nameOf(person.id)}`,
          for: [{ user: person.id }],
          ...shapeOf(config),
          reason:
            config.reason?.(person) ??
            `${person.name ?? person.email ?? person.id}'s machine`,
        })),
    ];
  };
}

function shapeOf(shape: MachineShape): MachineShape {
  return {
    ...(shape.labels ? { labels: shape.labels } : {}),
    ...(shape.options ? { options: shape.options } : {}),
    ...(shape.trusted !== undefined ? { trusted: shape.trusted } : {}),
    ...(shape.lostAfterMinutes !== undefined
      ? { lostAfterMinutes: shape.lostAfterMinutes }
      : {}),
  };
}

/** A machine that exists or is on its way: not lost, not being destroyed. */
function standing(machine: MachineFacts): boolean {
  return machine.state !== "lost" && machine.state !== "destroying";
}

/**
 * Machines that come and go with the work waiting for them: up to `max`,
 * named `<prefix>-1`, `<prefix>-2`, ... Each is kept while it starts, holds
 * work, or has been idle for less than `idleMinutes`; the most recently
 * idle are kept up to `keep` (warm spares). Waiting work no kept machine
 * has room for gets new machines, each sized by `options` for the work it
 * is made for.
 */
export function onDemand(
  config: {
    prefix: string;
    max: number;
    /** Machines kept warm with nothing to do (default 0). */
    keep?: number;
    /** Minutes a machine stays once idle (default 10). */
    idleMinutes?: number;
    /** Whose work these machines take; left out, anyone's. */
    for?: readonly MachinePrincipal[];
    /** The waiting work these machines are for, beyond labels and `for`. */
    serves?: (work: WaitingWork) => boolean;
    /** A new machine's options, from the work it is made for (none: a warm one). */
    sizeFor?: (
      work: WaitingWork | undefined,
    ) => Readonly<Record<string, unknown>>;
    reason?: string;
  } & MachineShape,
): MachinePolicy {
  const idleMinutes = config.idleMinutes ?? 10;
  const keep = config.keep ?? 0;
  return ({ facts, machines }) => {
    const entry = (
      name: string,
      options: Readonly<Record<string, unknown>>,
    ) => ({
      name,
      ...(config.for ? { for: config.for } : {}),
      ...shapeOf(config),
      options,
      reason: config.reason ?? "Made for waiting work",
    });
    const mine = facts.machines.filter(
      (machine) =>
        machine.managed &&
        machine.name.startsWith(`${config.prefix}-`) &&
        /^\d+$/.test(machine.name.slice(config.prefix.length + 1)) &&
        standing(machine),
    );
    const waiting = facts.work.filter(
      (work) => takes(config, work) && (config.serves?.(work) ?? true),
    );
    const kept: MachineFacts[] = [];
    const idle: MachineFacts[] = [];
    for (const machine of mine) {
      const busy =
        machine.state === "starting" ||
        machine.state === "resuming" ||
        machine.state === "unreachable" ||
        machine.state === "disabled" ||
        machine.holding.workspaces > 0 ||
        // Short of disk and idle, it goes: a machine with room takes its place.
        (machine.idleSince !== null &&
          !machine.disk?.low &&
          minutesSince(facts.now, machine.idleSince) < idleMinutes);
      if (busy) kept.push(machine);
      else if (machine.state === "serving" && !machine.disk?.low)
        idle.push(machine);
    }
    // The most recently idle stay as warm spares.
    idle.sort(
      (left, right) =>
        Date.parse(right.idleSince ?? "") - Date.parse(left.idleSince ?? ""),
    );
    for (const machine of idle) {
      if (kept.length >= keep) break;
      kept.push(machine);
    }
    // Work a kept machine has room for lands there on its next try; one
    // still starting takes one piece.
    let room = 0;
    for (const machine of kept) {
      if (machine.state !== "serving")
        room +=
          machine.state === "starting" || machine.state === "resuming" ? 1 : 0;
      else if (!machine.disk?.low)
        room += Math.max(
          0,
          (machine.capacity?.workspaces ?? 1) -
            (machine.usage?.workspaces ?? machine.holding.workspaces),
        );
    }
    const unmet = waiting.slice(room);
    const add = Math.max(
      0,
      Math.min(
        config.max - kept.length,
        Math.max(unmet.length, keep - kept.length),
      ),
    );
    const taken = new Set(mine.map((machine) => machine.name));
    const planned = kept.map((machine) => entry(machine.name, machine.options));
    for (let index = 1, made = 0; made < add; index += 1) {
      const name = `${config.prefix}-${index}`;
      if (taken.has(name)) continue;
      planned.push(
        entry(name, config.sizeFor?.(unmet[made]) ?? config.options ?? {}),
      );
      made += 1;
    }
    return [...machines, ...planned];
  };
}

/**
 * One machine for each chat key of a project: a pull request reviewer's
 * machine per pull request, named `<prefix>-<key>`. A key gets its machine
 * when its chat waits for one, and keeps it while `keep` says so (by
 * default, for as long as the machine exists: pair it with `stopWhenIdle`
 * and `destroyStoppedAfter`, or `dropWhenIdle`).
 */
export function onePerChatKey(
  config: {
    prefix: string;
    project: string;
    /** The waiting chats that get one, beyond the project and labels. */
    serves?: (work: WaitingWork) => boolean;
    /** Whether a key that has a machine keeps it (a pull request still open). */
    keep?: (key: string) => boolean | Promise<boolean>;
    /** At most this many machines; further keys wait (default 50). */
    max?: number;
    sizeFor?: (
      work: WaitingWork | undefined,
    ) => Readonly<Record<string, unknown>>;
  } & MachineShape,
): MachinePolicy {
  return async ({ facts, machines }) => {
    const keyOf = (machine: MachineFacts): string | undefined => {
      if (!machine.managed || !machine.name.startsWith(`${config.prefix}-`))
        return undefined;
      const [principal] = machine.for ?? [];
      return principal &&
        "key" in principal &&
        principal.project === config.project &&
        machine.for?.length === 1
        ? principal.key
        : undefined;
    };
    const planned = new Map<string, DesiredMachine>();
    const entry = (
      key: string,
      options: Readonly<Record<string, unknown>>,
    ): DesiredMachine => ({
      name: `${config.prefix}-${nameOf(key)}`,
      for: [{ project: config.project, key }],
      ...shapeOf(config),
      options,
      reason: `For ${key}`,
    });
    for (const machine of facts.machines) {
      const key = keyOf(machine);
      if (key === undefined || !standing(machine)) continue;
      if (
        machine.holding.workspaces === 0 &&
        config.keep &&
        !(await config.keep(key))
      )
        continue;
      planned.set(key, entry(key, machine.options));
    }
    for (const work of facts.work) {
      if (
        work.project !== config.project ||
        work.user !== null ||
        work.key === null ||
        planned.has(work.key) ||
        planned.size >= (config.max ?? 50)
      )
        continue;
      const candidate = entry(
        work.key,
        config.sizeFor?.(work) ?? config.options ?? {},
      );
      if (takes(candidate, work) && (config.serves?.(work) ?? true))
        planned.set(work.key, candidate);
    }
    return [...machines, ...planned.values()];
  };
}

/** The fact for a planned machine, when Work knows it. */
function factOf(
  facts: MachinePlanFacts,
  machine: DesiredMachine,
): MachineFacts | undefined {
  return facts.machines.find((entry) => entry.name === machine.name);
}

function wanted(facts: MachinePlanFacts, machine: DesiredMachine): boolean {
  return facts.work.some((work) => takes(machine, work));
}

/** Only the machines `only` picks (by default, all of them). */
type Only = { only?: (machine: DesiredMachine) => boolean };

/**
 * Stop a machine that has held no work for `minutes`, keeping its disk
 * (its worker's identity, members' sign-ins, volumes and caches), and start
 * it again when work waits for it. Work stops a machine only once it holds
 * no live work, and only when the hook has `stop` and `start`.
 */
export function stopWhenIdle(
  config: { minutes: number } & Only,
): MachinePolicy {
  return ({ facts, machines }) =>
    machines.map((machine) => {
      const fact = factOf(facts, machine);
      if (!fact?.managed || machine.state !== undefined) return machine;
      if (config.only && !config.only(machine)) return machine;
      if (wanted(facts, machine)) return machine;
      const stopped =
        fact.state === "stopped" ||
        fact.state === "stopping" ||
        (fact.state === "serving" &&
          minutesSince(facts.now, fact.idleSince) >= config.minutes);
      return stopped
        ? {
            ...machine,
            state: "stopped" as const,
            reason: `Stopped after ${config.minutes} idle minutes; it starts again when work waits for it`,
          }
        : machine;
    });
}

/** Drop a machine that has been stopped for `days`: Work destroys it. */
export function destroyStoppedAfter(
  config: { days: number } & Only,
): MachinePolicy {
  return ({ facts, machines }) =>
    machines.filter((machine) => {
      const fact = factOf(facts, machine);
      if (fact?.state !== "stopped" || wanted(facts, machine)) return true;
      if (config.only && !config.only(machine)) return true;
      return minutesSince(facts.now, fact.since) < config.days * 24 * 60;
    });
}

/**
 * Drop a machine that has held no work for `minutes`: Work destroys it
 * once it is dropped, since it holds nothing.
 */
export function dropWhenIdle(
  config: { minutes: number } & Only,
): MachinePolicy {
  return ({ facts, machines }) =>
    machines.filter((machine) => {
      const fact = factOf(facts, machine);
      if (!fact?.managed || wanted(facts, machine)) return true;
      if (config.only && !config.only(machine)) return true;
      return !(
        (fact.state === "serving" || fact.state === "draining") &&
        fact.idleSince !== null &&
        minutesSince(facts.now, fact.idleSince) >= config.minutes
      );
    });
}

/**
 * Replace a machine that was created and has not connected for `minutes`
 * (it could not reach the server, or its sandboxes do not start): dropped
 * from the plan, Work destroys it, and the next plan names it again, so it
 * is made anew. A machine that was lost needs nothing here: Work replaces
 * one the plan still names by itself. `attempts` bounds how often, by a
 * count the host keeps (left out, for ever).
 */
export function replaceNeverEnrolled(
  config: { minutes: number } & Only,
): MachinePolicy {
  return ({ facts, machines }) =>
    machines.filter((machine) => {
      const fact = factOf(facts, machine);
      if (!fact?.managed || fact.state !== "starting" || fact.ref === null)
        return true;
      if (config.only && !config.only(machine)) return true;
      return minutesSince(facts.now, fact.since) < config.minutes;
    });
}
