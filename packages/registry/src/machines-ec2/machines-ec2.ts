import {
  _InstanceType,
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  EC2Client,
  type Instance,
  type InstanceStateName,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  type BoundaryContext,
  defineSecrets,
  defineWorkflow,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

/**
 * Work server machines on Amazon EC2 (ADR 0327). A `workflow` machine class
 * in the server's WORK_MACHINES_CONFIG names this project, `createMachine`
 * and `destroyMachine`; its `options` reach both unread:
 *
 *   region            "eu-west-1"
 *   instanceType      "r7i.2xlarge"
 *   image             an AMI id, or "resolve:ssm:<public parameter>"
 *   subnetId          the subnet machines start in
 *   securityGroupIds  optional; the subnet's VPC default otherwise
 *   rootVolumeGb      optional; gp3, encrypted, deleted with the machine
 *   rootDeviceName    optional; "/dev/sda1" (Ubuntu) by default
 *   market            "on-demand" (default) or "spot"
 *   instanceProfile   optional; an instance profile name for the machine
 *   tags              optional; extra tags, also required by destroy
 */

export const awsSecrets = defineSecrets({
  AWS_ACCESS_KEY_ID: {
    label: "AWS access key id",
    description: "Of the IAM user or role session the machines policy allows",
  },
  AWS_SECRET_ACCESS_KEY: {
    label: "AWS secret access key",
    description: "Paired with AWS_ACCESS_KEY_ID",
  },
});

/** Tags Work's machines carry; destroy finds a machine by them. */
const MACHINE_TAG = "work-machine";
const RULE_TAG = "work-rule";
const CLASS_TAG = "work-class";
const OWN_TAGS = [MACHINE_TAG, RULE_TAG, CLASS_TAG, "Name"];

/**
 * EC2 errors that mean nothing was launched and asking again with the same
 * request would fail the same way: Work withdraws the code and tries a new
 * one. Throttling and server errors are uncertain, and the run fails.
 */
const REFUSALS =
  /^(Invalid|Unauthorized|AuthFailure|Unsupported|MissingParameter|InsufficientInstanceCapacity|InsufficientCapacity|InsufficientFreeAddressesInSubnet|InstanceLimitExceeded|VcpuLimitExceeded|MaxSpotInstanceCountExceeded|SpotMaxPriceTooLow|OptInRequired|PendingVerification|Blocked)/;

/**
 * How long after a create was asked for a missing instance may still be
 * one EC2 has not listed yet.
 */
const LISTING_GRACE_MS = 10 * 60_000;

/** States an instance leaves only by being terminated. */
const ALIVE: InstanceStateName[] = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
];

interface Ec2Options {
  region: string;
  instanceType: string;
  image: string;
  subnetId: string;
  securityGroupIds?: string[];
  rootVolumeGb?: number;
  rootDeviceName?: string;
  market?: "on-demand" | "spot";
  instanceProfile?: string;
  tags?: Record<string, string>;
}

/** The class's options, or what is wrong with them. */
function ec2Options(options: unknown): Ec2Options | { invalid: string } {
  const value =
    options && typeof options === "object" && !Array.isArray(options)
      ? Object.fromEntries(Object.entries(options))
      : {};
  const text = (key: string) => {
    const entry = value[key];
    return typeof entry === "string" && entry.length > 0 ? entry : undefined;
  };
  const region = text("region");
  const instanceType = text("instanceType");
  const image = text("image");
  const subnetId = text("subnetId");
  if (!region || !instanceType || !image || !subnetId)
    return {
      invalid:
        "The class's options need region, instanceType, image and subnetId",
    };
  const groups = value.securityGroupIds;
  const size = value.rootVolumeGb;
  const market = value.market ?? "on-demand";
  const tags = value.tags;
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
  const extra: Record<string, string> = {};
  if (tags !== undefined) {
    if (!tags || typeof tags !== "object" || Array.isArray(tags))
      return { invalid: "tags maps tag names to values" };
    for (const [key, tag] of Object.entries(tags)) {
      if (typeof tag !== "string" || OWN_TAGS.includes(key))
        return {
          invalid: `tags are text, and ${OWN_TAGS.join(", ")} are Work's own (${key})`,
        };
      extra[key] = tag;
    }
  }
  const deviceName = text("rootDeviceName");
  const profile = text("instanceProfile");
  return {
    region,
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
    ...(tags !== undefined ? { tags: extra } : {}),
  };
}

const INSTANCE_TYPES: readonly string[] = Object.values(_InstanceType);

/** An instance type this version of the EC2 client knows. */
function isInstanceType(value: string): value is _InstanceType {
  return INSTANCE_TYPES.includes(value);
}

function ec2Client(region: string): EC2Client {
  return new EC2Client({
    region,
    credentials: {
      accessKeyId: awsSecrets.AWS_ACCESS_KEY_ID,
      secretAccessKey: awsSecrets.AWS_SECRET_ACCESS_KEY,
    },
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/**
 * @displayname Launch EC2 instance
 * @icon server
 * @param request - @displayname Machine | @description The machine Work asks for, with its enrollment
 */
async function launchInstance({
  request,
}: {
  request: TriggerPayload<"machine.create">;
}): Promise<{ ref: string } | { refused: string }> {
  "use step";
  const options = ec2Options(request.options);
  if ("invalid" in options) return { refused: options.invalid };
  const instanceType = options.instanceType;
  if (!isInstanceType(instanceType))
    return {
      refused: `Instance type ${instanceType} is unknown to this @aws-sdk/client-ec2; check the name or update the package`,
    };
  const userData = request.enrollment.cloudInit;
  if (!userData)
    return { refused: "This Work server cannot install machines yet" };
  const tags = [
    ...Object.entries(options.tags ?? {}),
    [MACHINE_TAG, request.name],
    [RULE_TAG, request.rule],
    [CLASS_TAG, request.class],
    ["Name", request.name],
  ].map(([Key, Value]) => ({ Key, Value }));
  try {
    const launched = await ec2Client(options.region).send(
      new RunInstancesCommand({
        // The same token always means the same instance, so a retried
        // step never launches a second one. EC2 allows 64 characters.
        ClientToken: request.enrollment.idempotencyKey.slice(0, 64),
        ImageId: options.image,
        InstanceType: instanceType,
        MinCount: 1,
        MaxCount: 1,
        SubnetId: options.subnetId,
        ...(options.securityGroupIds
          ? { SecurityGroupIds: options.securityGroupIds }
          : {}),
        UserData: Buffer.from(userData).toString("base64"),
        // IMDSv2 only, one hop: the sandboxes on the machine cannot reach
        // its instance metadata or any role it has.
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
        InstanceInitiatedShutdownBehavior: "terminate",
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
}

/**
 * @displayname Terminate EC2 instances
 * @icon trash-2
 * @param request - @displayname Machine | @description The machine to remove, by its instance id and its name tag
 */
async function terminateInstances({
  request,
}: {
  request: TriggerPayload<"machine.destroy">;
}): Promise<{ done: boolean }> {
  "use step";
  const options = ec2Options(request.options);
  if ("invalid" in options) throw new Error(options.invalid);
  const client = ec2Client(options.region);
  const found = new Map<string, Instance>();
  const collect = async (
    input: ConstructorParameters<typeof DescribeInstancesCommand>[0],
  ) => {
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
  if (request.ref?.startsWith("i-"))
    await collect({ InstanceIds: [request.ref] });
  // A create that answered uncertainly may have launched one with no ref:
  // its ClientToken finds it whatever its tags or class say now. Without
  // a key, the name tag and the class's own tags (the server's scope) do.
  await collect({
    Filters: [
      ...(request.idempotencyKey
        ? [
            {
              Name: "client-token",
              Values: [request.idempotencyKey.slice(0, 64)],
            },
          ]
        : [
            { Name: `tag:${MACHINE_TAG}`, Values: [request.name] },
            ...Object.entries(options.tags ?? {}).map(([key, value]) => ({
              Name: `tag:${key}`,
              Values: [value],
            })),
          ]),
      { Name: "instance-state-name", Values: ALIVE },
    ],
  });
  const alive = [...found.values()].filter(
    (instance) =>
      instance.State?.Name !== undefined && ALIVE.includes(instance.State.Name),
  );
  if (alive.length === 0) {
    // EC2 lists a new instance late: just after RunInstances it can be
    // unknown by id and missing from filters. Gone only after a while.
    const requested = request.requestedAt
      ? Date.parse(request.requestedAt)
      : Number.NaN;
    return { done: !(Date.now() - requested < LISTING_GRACE_MS) };
  }
  const terminate = alive
    .filter((instance) => instance.State?.Name !== "shutting-down")
    .flatMap((instance) => (instance.InstanceId ? [instance.InstanceId] : []));
  if (terminate.length > 0)
    await client.send(
      new TerminateInstancesCommand({ InstanceIds: terminate }),
    );
  // Done once a later run finds them terminated.
  return { done: false };
}

/** @displayname Create EC2 machine */
export const createMachine = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("machine.create")],
  steps: [
    /** @displayname Launch the instance */
    defineBoundary({
      run: ({ input }: BoundaryContext<TriggerPayload<"machine.create">>) =>
        launchInstance({ request: input }),
    }),
  ],
}));

/** @displayname Destroy EC2 machine */
export const destroyMachine = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("machine.destroy")],
  steps: [
    /** @displayname Terminate its instances */
    defineBoundary({
      run: ({ input }: BoundaryContext<TriggerPayload<"machine.destroy">>) =>
        terminateInstances({ request: input }),
    }),
  ],
}));
