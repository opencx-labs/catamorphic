/**
 * The part of `@aws-sdk/client-ec2` the machines-ec2 recipe calls, typed by
 * the real client, answering from a handler a test installs. The recipe's
 * behavior tests run against it; no AWS call is made. Its typecheck runs
 * against the real client.
 */
import type {
  DescribeInstancesCommandInput,
  DescribeInstancesCommandOutput,
  EC2ClientConfig,
  RunInstancesCommandInput,
  RunInstancesCommandOutput,
  TerminateInstancesCommandInput,
  TerminateInstancesCommandOutput,
} from "@aws-sdk/client-ec2";

export { _InstanceType } from "@aws-sdk/client-ec2";

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
  constructor(readonly config: EC2ClientConfig) {}

  send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>;
  send(
    command: DescribeInstancesCommand,
  ): Promise<DescribeInstancesCommandOutput>;
  send(
    command: TerminateInstancesCommand,
  ): Promise<TerminateInstancesCommandOutput>;
  async send(command: Command): Promise<unknown> {
    const credentials = this.config.credentials;
    if (
      !credentials ||
      typeof credentials === "function" ||
      !credentials.accessKeyId ||
      !credentials.secretAccessKey
    )
      throw new Ec2Error("AuthFailure");
    return handler({
      command: command.command,
      input: command.input,
      region: typeof this.config.region === "string" ? this.config.region : "",
    });
  }
}
