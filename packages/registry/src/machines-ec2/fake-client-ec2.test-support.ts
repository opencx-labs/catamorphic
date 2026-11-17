/**
 * The part of `@aws-sdk/client-ec2` the machines-ec2 recipe uses, with the
 * same names and shapes, answering from a handler a test installs. The
 * recipe's tests typecheck and run against it; no AWS call is made.
 */

export const _InstanceType = {
  m7i_4xlarge: "m7i.4xlarge",
  r7i_2xlarge: "r7i.2xlarge",
  t3_micro: "t3.micro",
} as const;
export type _InstanceType = (typeof _InstanceType)[keyof typeof _InstanceType];

export type InstanceStateName =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped";

export interface Tag {
  Key?: string | undefined;
  Value?: string | undefined;
}

export interface Instance {
  InstanceId?: string | undefined;
  State?: { Name?: InstanceStateName | undefined } | undefined;
  Tags?: Tag[] | undefined;
}

export interface RunInstancesCommandInput {
  ClientToken?: string | undefined;
  ImageId?: string | undefined;
  InstanceType?: _InstanceType | undefined;
  MinCount: number | undefined;
  MaxCount: number | undefined;
  SubnetId?: string | undefined;
  SecurityGroupIds?: string[] | undefined;
  UserData?: string | undefined;
  MetadataOptions?:
    | {
        HttpTokens?: "optional" | "required" | undefined;
        HttpEndpoint?: "disabled" | "enabled" | undefined;
        HttpPutResponseHopLimit?: number | undefined;
      }
    | undefined;
  BlockDeviceMappings?:
    | Array<{
        DeviceName?: string | undefined;
        Ebs?:
          | {
              VolumeSize?: number | undefined;
              VolumeType?: "gp2" | "gp3" | "io1" | "io2" | undefined;
              Encrypted?: boolean | undefined;
              DeleteOnTermination?: boolean | undefined;
            }
          | undefined;
      }>
    | undefined;
  InstanceMarketOptions?:
    | {
        MarketType?: "spot" | "capacity-block" | undefined;
        SpotOptions?:
          | {
              SpotInstanceType?: "one-time" | "persistent" | undefined;
              InstanceInterruptionBehavior?:
                | "hibernate"
                | "stop"
                | "terminate"
                | undefined;
            }
          | undefined;
      }
    | undefined;
  IamInstanceProfile?: { Arn?: string; Name?: string } | undefined;
  InstanceInitiatedShutdownBehavior?: "stop" | "terminate" | undefined;
  TagSpecifications?:
    | Array<{
        ResourceType?: "instance" | "volume" | undefined;
        Tags?: Tag[] | undefined;
      }>
    | undefined;
}

export interface RunInstancesCommandOutput {
  Instances?: Instance[] | undefined;
}

export interface DescribeInstancesCommandInput {
  InstanceIds?: string[] | undefined;
  Filters?: Array<{ Name?: string; Values?: string[] }> | undefined;
  NextToken?: string | undefined;
}

export interface DescribeInstancesCommandOutput {
  Reservations?: Array<{ Instances?: Instance[] | undefined }> | undefined;
  NextToken?: string | undefined;
}

export interface TerminateInstancesCommandInput {
  InstanceIds: string[] | undefined;
}

export interface TerminateInstancesCommandOutput {
  TerminatingInstances?: Array<{ InstanceId?: string }> | undefined;
}

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

type Command =
  | RunInstancesCommand
  | DescribeInstancesCommand
  | TerminateInstancesCommand;

/** What the test answers each call with; it may throw an EC2 error. */
export type Ec2Handler = (call: {
  command: Command["command"];
  input: Command["input"];
  region: string;
}) => unknown;

let handler: Ec2Handler = () => {
  throw new Error("No EC2 handler installed");
};

export function setEc2Handler(next: Ec2Handler): void {
  handler = next;
}

/** An EC2 service error, named by its code as the SDK names them. */
export class Ec2Error extends Error {
  constructor(code: string, message = code) {
    super(message);
    this.name = code;
  }
}

export class EC2Client {
  constructor(
    readonly config: {
      region: string;
      credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    },
  ) {}

  send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>;
  send(
    command: DescribeInstancesCommand,
  ): Promise<DescribeInstancesCommandOutput>;
  send(
    command: TerminateInstancesCommand,
  ): Promise<TerminateInstancesCommandOutput>;
  async send(command: Command): Promise<unknown> {
    if (
      !this.config.credentials.accessKeyId ||
      !this.config.credentials.secretAccessKey
    )
      throw new Ec2Error("AuthFailure");
    return handler({
      command: command.command,
      input: command.input,
      region: this.config.region,
    });
  }
}
