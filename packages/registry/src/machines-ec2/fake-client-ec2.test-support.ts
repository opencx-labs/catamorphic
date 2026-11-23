/**
 * The part of `@aws-sdk/client-ec2` the machines-ec2 recipe calls, typed by
 * the real client: an EC2 kept in memory, with a clock a test moves. The
 * recipe's behavior tests mock the client module with this one; no AWS call
 * is made. Its typecheck runs against the real client.
 */
import type {
  DescribeInstancesCommandInput,
  DescribeInstancesCommandOutput,
  EC2ClientConfig,
  Instance,
  InstanceStateName,
  RunInstancesCommandInput,
  RunInstancesCommandOutput,
  StartInstancesCommandInput,
  StartInstancesCommandOutput,
  StopInstancesCommandInput,
  StopInstancesCommandOutput,
  TerminateInstancesCommandInput,
  TerminateInstancesCommandOutput,
} from "@aws-sdk/client-ec2";

/** The instance types the tests launch; the real client knows many more. */
export const _InstanceType = {
  r7i_2xlarge: "r7i.2xlarge",
  m7i_large: "m7i.large",
  t3_medium: "t3.medium",
} as const;

export class RunInstancesCommand {
  readonly command = "RunInstances";
  constructor(readonly input: RunInstancesCommandInput) {}
}

export class DescribeInstancesCommand {
  readonly command = "DescribeInstances";
  constructor(readonly input: DescribeInstancesCommandInput) {}
}

export class TerminateInstancesCommand {
  readonly command = "TerminateInstances";
  constructor(readonly input: TerminateInstancesCommandInput) {}
}

export class StopInstancesCommand {
  readonly command = "StopInstances";
  constructor(readonly input: StopInstancesCommandInput) {}
}

export class StartInstancesCommand {
  readonly command = "StartInstances";
  constructor(readonly input: StartInstancesCommandInput) {}
}

type Command =
  | RunInstancesCommand
  | DescribeInstancesCommand
  | TerminateInstancesCommand
  | StopInstancesCommand
  | StartInstancesCommand;

/** An EC2 service error, named by its code as the SDK names them. */
export class Ec2Error extends Error {
  constructor(code: string, message = code) {
    super(message);
    this.name = code;
  }
}

interface FakeInstance {
  id: string;
  token: string;
  state: InstanceStateName;
  /** When its current transition (pending, stopping, shutting-down) ends. */
  settlesAt: number;
  launchedAt: number;
  input: RunInstancesCommandInput;
}

/** How long an instance takes to change state. */
const TRANSITION_MS = 30_000;
/** How long a terminated instance stays listed. */
const TERMINATED_LISTED_MS = 60 * 60_000;

/**
 * EC2 in memory: instances launched once per ClientToken, changing state
 * over a clock the test moves, with tags and filters as the recipe uses
 * them. `calls` records what was asked; `fail` makes the next call of a
 * command throw.
 */
export class FakeEc2 {
  readonly calls: Array<{ command: Command["command"]; input: unknown }> = [];
  private readonly instances: FakeInstance[] = [];
  private readonly failures = new Map<Command["command"], Ec2Error[]>();
  private clock = Date.parse("2026-01-01T00:00:00.000Z");
  /** A new instance is not listed until this long after its launch. */
  listingLagMs = 0;

  now = (): number => this.clock;

  advance(ms: number): void {
    this.clock += ms;
    for (const instance of this.instances) this.settle(instance);
  }

  /** Move the clock to a moment (ISO 8601), never backwards. */
  advanceTo(moment: string): void {
    this.advance(Math.max(0, Date.parse(moment) - this.clock));
  }

  /** The next call of `command` throws `error`. */
  fail(command: Command["command"], error: Ec2Error): void {
    this.failures.set(command, [...(this.failures.get(command) ?? []), error]);
  }

  /** Instances that still exist: anything but terminated. */
  alive(): Array<{ id: string; state: InstanceStateName; name: string }> {
    return this.instances
      .filter((instance) => instance.state !== "terminated")
      .map((instance) => ({
        id: instance.id,
        state: instance.state,
        name: tagsOf(instance).Name ?? "",
      }));
  }

  /** What an instance was launched with. */
  launch(id: string): RunInstancesCommandInput | undefined {
    return this.instances.find((instance) => instance.id === id)?.input;
  }

  /** End an instance as EC2 would: a reclaim, a termination from the console. */
  kill(id: string): void {
    const instance = this.instances.find((entry) => entry.id === id);
    if (!instance) return;
    instance.state = "terminated";
    instance.settlesAt = this.clock;
  }

  private settle(instance: FakeInstance): void {
    if (this.clock < instance.settlesAt) return;
    if (instance.state === "pending") instance.state = "running";
    else if (instance.state === "stopping") instance.state = "stopped";
    else if (instance.state === "shutting-down") instance.state = "terminated";
  }

  private transition(instance: FakeInstance, state: InstanceStateName): void {
    instance.state = state;
    instance.settlesAt = this.clock + TRANSITION_MS;
  }

  private listed(instance: FakeInstance): boolean {
    if (this.clock - instance.launchedAt < this.listingLagMs) return false;
    return (
      instance.state !== "terminated" ||
      this.clock - instance.settlesAt < TERMINATED_LISTED_MS
    );
  }

  private require(ids: readonly string[] | undefined): FakeInstance[] {
    return (ids ?? []).map((id) => {
      const instance = this.instances.find((entry) => entry.id === id);
      if (!instance || !this.listed(instance))
        throw new Ec2Error("InvalidInstanceID.NotFound");
      return instance;
    });
  }

  handle(command: Command): unknown {
    this.calls.push({ command: command.command, input: command.input });
    const failure = this.failures.get(command.command)?.shift();
    if (failure) throw failure;
    for (const instance of this.instances) this.settle(instance);
    if (command instanceof RunInstancesCommand) {
      const token =
        command.input.ClientToken ?? `none-${this.instances.length}`;
      const existing = this.instances.find((entry) => entry.token === token);
      const instance: FakeInstance = existing ?? {
        id: `i-${String(this.instances.length + 1).padStart(17, "0")}`,
        token,
        state: "pending",
        settlesAt: this.clock + TRANSITION_MS,
        launchedAt: this.clock,
        input: command.input,
      };
      if (!existing) this.instances.push(instance);
      const output: RunInstancesCommandOutput = {
        $metadata: {},
        Instances: [describe(instance)],
      };
      return output;
    }
    if (command instanceof DescribeInstancesCommand) {
      const byId = command.input.InstanceIds;
      const candidates = byId
        ? this.require(byId)
        : this.instances.filter((instance) => this.listed(instance));
      const matching = candidates.filter((instance) =>
        (command.input.Filters ?? []).every((filter) => {
          const values = filter.Values ?? [];
          if (filter.Name === "client-token")
            return values.includes(instance.token);
          if (filter.Name === "instance-state-name")
            return values.includes(instance.state);
          if (filter.Name?.startsWith("tag:"))
            return values.includes(
              tagsOf(instance)[filter.Name.slice("tag:".length)] ?? "",
            );
          return false;
        }),
      );
      const output: DescribeInstancesCommandOutput = {
        $metadata: {},
        Reservations: [{ Instances: matching.map(describe) }],
      };
      return output;
    }
    if (command instanceof TerminateInstancesCommand) {
      for (const instance of this.require(command.input.InstanceIds))
        if (instance.state !== "terminated")
          this.transition(instance, "shutting-down");
      const output: TerminateInstancesCommandOutput = { $metadata: {} };
      return output;
    }
    if (command instanceof StopInstancesCommand) {
      for (const instance of this.require(command.input.InstanceIds)) {
        if (
          instance.input.InstanceMarketOptions?.MarketType === "spot" &&
          instance.input.InstanceMarketOptions.SpotOptions?.SpotInstanceType ===
            "one-time"
        )
          throw new Ec2Error("UnsupportedOperation");
        if (instance.state === "running" || instance.state === "pending")
          this.transition(instance, "stopping");
        else if (instance.state !== "stopping" && instance.state !== "stopped")
          throw new Ec2Error("IncorrectInstanceState");
      }
      const output: StopInstancesCommandOutput = { $metadata: {} };
      return output;
    }
    for (const instance of this.require(command.input.InstanceIds)) {
      if (instance.state === "stopped") this.transition(instance, "pending");
      else if (instance.state !== "running" && instance.state !== "pending")
        throw new Ec2Error("IncorrectInstanceState");
    }
    const output: StartInstancesCommandOutput = { $metadata: {} };
    return output;
  }
}

function tagsOf(instance: FakeInstance): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const specification of instance.input.TagSpecifications ?? [])
    if (specification.ResourceType === "instance")
      for (const tag of specification.Tags ?? [])
        if (tag.Key) tags[tag.Key] = tag.Value ?? "";
  return tags;
}

function describe(instance: FakeInstance): Instance {
  return {
    InstanceId: instance.id,
    State: { Name: instance.state },
    ...(instance.input.InstanceMarketOptions?.MarketType === "spot"
      ? { InstanceLifecycle: "spot" as const }
      : {}),
    Tags: Object.entries(tagsOf(instance)).map(([Key, Value]) => ({
      Key,
      Value,
    })),
  };
}

let current = new FakeEc2();

/** The EC2 every client made from now on talks to. */
export function useFakeEc2(fake: FakeEc2): void {
  current = fake;
}

export class EC2Client {
  constructor(readonly config: EC2ClientConfig) {}

  send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>;
  send(
    command: DescribeInstancesCommand,
  ): Promise<DescribeInstancesCommandOutput>;
  send(
    command: TerminateInstancesCommand,
  ): Promise<TerminateInstancesCommandOutput>;
  send(command: StopInstancesCommand): Promise<StopInstancesCommandOutput>;
  send(command: StartInstancesCommand): Promise<StartInstancesCommandOutput>;
  async send(command: Command): Promise<unknown> {
    return current.handle(command);
  }
}
