import { gzipSync } from "node:zlib";
import {
  _InstanceType,
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  EC2Client,
  type EC2ClientConfig,
  type Instance,
  type InstanceStateName,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type {
  MachineCreateRequest,
  MachinesHook,
  MachineTarget,
} from "@catamorphic/work-server";

/*
 * A Work server's machines on Amazon EC2 (ADR 0347): the provisioner half
 * of a machines hook, as host code from the `machines-ec2` pack, yours to
 * change. `ec2Machines(...)` returns `create`, `destroy`, `stop`, `start`
 * and `describe`; your `plan` decides which machines exist:
 *
 *   hooks: { machines: { plan, ...ec2Machines({ region, defaults, userData }) } }
 *
 * A machine's shape is its plan entry's `options`, laid over `defaults`:
 *
 *   instanceType      "r7i.2xlarge"
 *   image             an AMI id, or "resolve:ssm:<public parameter>"
 *   subnetId          the subnet machines start in
 *   securityGroupIds  optional; the subnet's VPC default otherwise
 *   rootVolumeGb      optional; gp3, encrypted, deleted with the machine
 *   rootDeviceName    optional; "/dev/sda1" (Ubuntu) by default
 *   market            "on-demand" (default) or "spot"; Spot cannot stop
 *   instanceProfile   optional; an instance profile name for the machine
 *
 * Credentials are the server's own (its role, or the environment), through
 * the AWS SDK's default chain, unless `client` passes others.
 */

export interface Ec2MachineOptions {
  instanceType: string;
  image: string;
  subnetId: string;
  securityGroupIds?: readonly string[];
  rootVolumeGb?: number;
  rootDeviceName?: string;
  market?: "on-demand" | "spot";
  instanceProfile?: string;
}

export interface Ec2MachinesConfig {
  region: string;
  /** Options every machine starts from; a plan entry's `options` override them. */
  defaults?: Partial<Ec2MachineOptions>;
  /**
   * The user data a new machine boots with: it must start the Work worker
   * with the enrollment. `workerUserData` from the `machines-install` pack
   * builds it for a stock or a baked image.
   */
  userData(request: MachineCreateRequest): string;
  /**
   * Tags on every machine and its volumes beside Work's own. They are the
   * server's scope: use one (`work-server: prod`) when several servers
   * share an account, and limit the IAM policy to it.
   */
  tags?: Readonly<Record<string, string>>;
  /** EC2 client settings beside the region: credentials, an endpoint. */
  client?: Omit<EC2ClientConfig, "region">;
  /** The clock (tests move it). */
  now?: () => number;
}

/** Tags Work's machines carry; destroy finds a machine by them. */
const MACHINE_TAG = "work-machine";
const OWN_TAGS = [MACHINE_TAG, "Name"];

/**
 * EC2 errors that mean nothing was launched and asking again with the same
 * request would fail the same way: Work withdraws the code and asks again
 * later under a new enrollment. Throttling and server errors are
 * uncertain: they are thrown, and Work repeats the create with its key.
 */
const REFUSALS =
  /^(Invalid|Unauthorized|AuthFailure|Unsupported|MissingParameter|InsufficientInstanceCapacity|InsufficientCapacity|InsufficientFreeAddressesInSubnet|InstanceLimitExceeded|VcpuLimitExceeded|MaxSpotInstanceCountExceeded|SpotMaxPriceTooLow|OptInRequired|PendingVerification|Blocked)/;

/**
 * How long after a destroy was first asked a missing instance may still be
 * one EC2 has not listed yet.
 */
const LISTING_GRACE_MS = 10 * 60_000;

/** EC2 takes at most this much user data, before base64. */
const USER_DATA_LIMIT = 16_384;

/** States an instance leaves only by being terminated. */
const ALIVE: InstanceStateName[] = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
];

/** A machine's options over the defaults, or what is wrong with them. */
function machineOptions(args: {
  defaults: Partial<Ec2MachineOptions>;
  options: Readonly<Record<string, unknown>>;
}): Ec2MachineOptions | { invalid: string } {
  const value: Record<string, unknown> = { ...args.defaults, ...args.options };
  const text = (key: string) => {
    const entry = value[key];
    return typeof entry === "string" && entry.length > 0 ? entry : undefined;
  };
  const instanceType = text("instanceType");
  const image = text("image");
  const subnetId = text("subnetId");
  if (!instanceType || !image || !subnetId)
    return {
      invalid:
        "A machine needs instanceType, image and subnetId, in its plan entry's options or the recipe's defaults",
    };
  const groups = value.securityGroupIds;
  const size = value.rootVolumeGb;
  const market = value.market ?? "on-demand";
  if (
    groups !== undefined &&
    !(Array.isArray(groups) && groups.every((id) => typeof id === "string"))
  )
    return { invalid: "securityGroupIds is a list of security group ids" };
  if (
    size !== undefined &&
    !(typeof size === "number" && Number.isInteger(size) && size >= 8)
  )
    return { invalid: "rootVolumeGb is a whole number of at least 8" };
  if (market !== "on-demand" && market !== "spot")
    return { invalid: 'market is "on-demand" or "spot"' };
  const deviceName = text("rootDeviceName");
  const profile = text("instanceProfile");
  return {
    instanceType,
    image,
    subnetId,
    ...(Array.isArray(groups)
      ? { securityGroupIds: groups.filter((id) => typeof id === "string") }
      : {}),
    ...(typeof size === "number" ? { rootVolumeGb: size } : {}),
    ...(deviceName ? { rootDeviceName: deviceName } : {}),
    market,
    ...(profile ? { instanceProfile: profile } : {}),
  };
}

const INSTANCE_TYPES: readonly string[] = Object.values(_InstanceType);

/** An instance type this version of the EC2 client knows. */
function isInstanceType(value: string): value is _InstanceType {
  return INSTANCE_TYPES.includes(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/** The provisioner verbs of a machines hook, on EC2. */
export function ec2Machines(
  config: Ec2MachinesConfig,
): Pick<MachinesHook, "create" | "destroy" | "stop" | "start" | "describe"> {
  for (const key of Object.keys(config.tags ?? {}))
    if (OWN_TAGS.includes(key))
      throw new Error(`The tags ${OWN_TAGS.join(" and ")} are Work's own`);
  const client = new EC2Client({ ...config.client, region: config.region });
  const now = config.now ?? Date.now;
  const defaults = config.defaults ?? {};

  /** Every instance a filter or an id finds, across pages. */
  const collect = async (
    found: Map<string, Instance>,
    input: ConstructorParameters<typeof DescribeInstancesCommand>[0],
  ): Promise<void> => {
    let token: string | undefined;
    do {
      let page: DescribeInstancesCommandOutput;
      try {
        page = await client.send(
          new DescribeInstancesCommand({
            ...input,
            ...(token ? { NextToken: token } : {}),
          }),
        );
      } catch (error) {
        // An instance gone long enough is not found at all.
        if (errorName(error).startsWith("InvalidInstanceID.")) return;
        throw error;
      }
      for (const reservation of page.Reservations ?? [])
        for (const instance of reservation.Instances ?? [])
          if (instance.InstanceId) found.set(instance.InstanceId, instance);
      token = page.NextToken;
    } while (token);
  };

  /**
   * The machine's instances, in any state EC2 still lists: by the id
   * `create` answered, and by the ClientToken it was launched with, which
   * finds a launch whose answer was lost whatever its tags say now. With
   * neither, by its name tag within the server's own tags.
   */
  const instancesOf = async (target: MachineTarget): Promise<Instance[]> => {
    const found = new Map<string, Instance>();
    if (target.ref?.startsWith("i-"))
      await collect(found, { InstanceIds: [target.ref] });
    await collect(found, {
      Filters: target.idempotencyKey
        ? [
            {
              Name: "client-token",
              Values: [target.idempotencyKey.slice(0, 64)],
            },
          ]
        : [
            { Name: `tag:${MACHINE_TAG}`, Values: [target.name] },
            ...Object.entries(config.tags ?? {}).map(([key, value]) => ({
              Name: `tag:${key}`,
              Values: [value],
            })),
          ],
    });
    return [...found.values()];
  };
  const stateOf = (instance: Instance) => instance.State?.Name;
  const alive = (instances: readonly Instance[]) =>
    instances.filter((instance) => {
      const state = stateOf(instance);
      return state !== undefined && ALIVE.includes(state);
    });
  const ids = (instances: readonly Instance[]) =>
    instances.flatMap((instance) =>
      instance.InstanceId ? [instance.InstanceId] : [],
    );
  /** Instances that can still serve again: not being terminated. */
  const kept = (instances: readonly Instance[]) =>
    alive(instances).filter(
      (instance) => stateOf(instance) !== "shutting-down",
    );

  return {
    create: async (request) => {
      const options = machineOptions({ defaults, options: request.options });
      if ("invalid" in options) return { refused: options.invalid };
      const instanceType = options.instanceType;
      if (!isInstanceType(instanceType))
        return {
          refused: `Instance type ${instanceType} is unknown to this @aws-sdk/client-ec2; check the name or update the package`,
        };
      const plain = Buffer.from(config.userData(request));
      // cloud-init reads gzip, which fits a long install script into EC2's limit.
      const userData =
        plain.byteLength > USER_DATA_LIMIT ? gzipSync(plain) : plain;
      if (userData.byteLength > USER_DATA_LIMIT)
        return {
          refused: `The user data is ${userData.byteLength} bytes compressed; EC2 takes ${USER_DATA_LIMIT}. Use a baked image, whose user data only starts the worker`,
        };
      const tags = [
        ...Object.entries(config.tags ?? {}),
        [MACHINE_TAG, request.name],
        ["Name", request.name],
      ].map(([Key, Value]) => ({ Key, Value }));
      try {
        const launched = await client.send(
          new RunInstancesCommand({
            // The same token always means the same instance, so Work
            // repeating this create never launches a second one. EC2
            // allows 64 characters: the key is 64 hex.
            ClientToken: request.enrollment.idempotencyKey.slice(0, 64),
            ImageId: options.image,
            InstanceType: instanceType,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: options.subnetId,
            ...(options.securityGroupIds
              ? { SecurityGroupIds: [...options.securityGroupIds] }
              : {}),
            UserData: userData.toString("base64"),
            // IMDSv2 only, one hop: the sandboxes on the machine cannot
            // reach its instance metadata or any role it has.
            MetadataOptions: {
              HttpTokens: "required",
              HttpEndpoint: "enabled",
              HttpPutResponseHopLimit: 1,
            },
            ...(options.rootVolumeGb
              ? {
                  BlockDeviceMappings: [
                    {
                      DeviceName: options.rootDeviceName ?? "/dev/sda1",
                      Ebs: {
                        VolumeSize: options.rootVolumeGb,
                        VolumeType: "gp3",
                        Encrypted: true,
                        DeleteOnTermination: true,
                      },
                    },
                  ],
                }
              : {}),
            ...(options.market === "spot"
              ? {
                  InstanceMarketOptions: {
                    MarketType: "spot",
                    SpotOptions: {
                      SpotInstanceType: "one-time",
                      InstanceInterruptionBehavior: "terminate",
                    },
                  },
                }
              : {}),
            ...(options.instanceProfile
              ? { IamInstanceProfile: { Name: options.instanceProfile } }
              : {}),
            // Never "terminate": a shutdown from inside, and Work's stop,
            // keep the machine and its disk, so start brings back the same
            // worker with its members' sign-ins, volumes and caches.
            ...(options.market === "spot"
              ? {}
              : { InstanceInitiatedShutdownBehavior: "stop" }),
            TagSpecifications: [
              { ResourceType: "instance", Tags: tags },
              { ResourceType: "volume", Tags: tags },
            ],
          }),
        );
        const id = launched.Instances?.[0]?.InstanceId;
        if (!id) throw new Error("EC2 answered without an instance id");
        return { ref: id };
      } catch (error) {
        const name = errorName(error);
        if (REFUSALS.test(name))
          return {
            refused: `${name}: ${error instanceof Error ? error.message : ""}`,
          };
        throw error;
      }
    },

    destroy: async (target) => {
      const listed = await instancesOf(target);
      const instances = alive(listed);
      if (instances.length === 0) {
        // Listed and terminated: gone. Listed nowhere: EC2 lists a new
        // instance late, so just after a launch it can be unknown by id
        // and missing from filters. Gone only once the grace has passed
        // since Work first asked.
        const requested = Date.parse(target.requestedAt);
        return {
          done:
            listed.length > 0 ||
            (Number.isFinite(requested) &&
              now() - requested >= LISTING_GRACE_MS),
        };
      }
      const terminate = ids(
        instances.filter((instance) => stateOf(instance) !== "shutting-down"),
      );
      if (terminate.length > 0)
        await client.send(
          new TerminateInstancesCommand({ InstanceIds: terminate }),
        );
      // Done once a later call finds them terminated.
      return { done: false };
    },

    stop: async (target) => {
      const instances = kept(await instancesOf(target));
      if (instances.some((instance) => instance.InstanceLifecycle === "spot"))
        throw new Error(
          `${target.name} is a Spot instance, which this recipe launches one-time: it cannot be stopped. Plan it "running", or launch it on-demand`,
        );
      const running = ids(
        instances.filter((instance) => {
          const state = stateOf(instance);
          return state === "running" || state === "pending";
        }),
      );
      if (running.length > 0)
        await client.send(new StopInstancesCommand({ InstanceIds: running }));
      // Stopped once every instance of it is (none left counts: start says gone).
      return {
        done: instances.every((instance) => stateOf(instance) === "stopped"),
      };
    },

    start: async (target) => {
      const instances = kept(await instancesOf(target));
      if (instances.length === 0) return { gone: true };
      const stopped = ids(
        instances.filter((instance) => stateOf(instance) === "stopped"),
      );
      if (stopped.length > 0)
        await client.send(new StartInstancesCommand({ InstanceIds: stopped }));
      // A stopping instance is started once it has stopped: Work asks again.
      return {
        done: instances.every((instance) => stateOf(instance) === "running"),
      };
    },

    describe: async (target) => {
      const instances = await instancesOf(target);
      const states = instances.map((instance) => stateOf(instance));
      if (states.some((state) => state === "running" || state === "pending"))
        return { state: "running" };
      if (states.some((state) => state === "stopped" || state === "stopping"))
        return { state: "stopped" };
      // EC2 lists a terminated instance for about an hour: seen so, it is
      // certainly gone. One it does not list at all may be listed late.
      return { state: instances.length > 0 ? "gone" : "unknown" };
    },
  };
}
