// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  renderTriggerTypesModule,
  TRIGGER_TYPES_SOURCE_PATH,
} from "@catamorphic/core";
import { checkProject, parseProject } from "@catamorphic/parser";
import { MACHINE_TRIGGER_KINDS } from "@catamorphic/server-sdk";
import { describe, expect, it } from "vitest";
import { packFiles } from "../pack-files.js";

const PACK = packFiles("machines-ec2");
const SOURCE = ".work/workflows/src/machines-ec2.ts";
const recipe = PACK.files[SOURCE] ?? "";
const root = path.resolve(import.meta.dirname, "../../../..");
const workflowModule = path.join(root, "packages/workflow/src/index.ts");
const fakeEc2 = path.join(
  import.meta.dirname,
  "fake-client-ec2.test-support.ts",
);

const KEY = createHash("sha256").update("wke_test-code").digest("hex");
const OPTIONS = {
  region: "eu-west-1",
  instanceType: "r7i.2xlarge",
  image:
    "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
  subnetId: "subnet-0abc",
  securityGroupIds: ["sg-0abc"],
  rootVolumeGb: 100,
  tags: { "work-server": "prod" },
};
const create = (options: unknown = OPTIONS) => ({
  name: "review-1a2b3c-1",
  class: "review",
  rule: "review",
  options,
  labels: { class: "review", pool: "review" },
  enrollment: {
    controlPlaneUrl: "https://work.example.com",
    code: "wke_test-code",
    idempotencyKey: KEY,
    cloudInit: "#cloud-config\nruncmd:\n  - [sh, /root/work.sh]\n",
  },
});

/**
 * Runs the shipped workflows under bun against the fake EC2 client: the
 * script sets `answer`, the handler every EC2 call reaches, and prints
 * what the workflows returned and the calls they made.
 */
async function run(script: string): Promise<{
  result: unknown;
  calls: Array<{ command: string; input: unknown; region: string }>;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ec2-recipe-"));
  try {
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      recipe
        .replace('"@catamorphic/workflow"', JSON.stringify(workflowModule))
        .replace('"@aws-sdk/client-ec2"', JSON.stringify(fakeEc2)),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { Ec2Error, setEc2Handler } from ${JSON.stringify(fakeEc2)};
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
      process.env.AWS_SECRET_ACCESS_KEY = "not-a-secret";
      const { createMachine, destroyMachine } = await import("./recipe.ts");
      const calls = [];
      let answer = () => ({});
      setEc2Handler((call) => {
        calls.push(call);
        return answer(call);
      });
      const result = await (async () => { ${script} })();
      console.log(JSON.stringify({ result, calls }));
    `,
    );
    const output = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 10000,
    });
    return JSON.parse(output.stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const instance = (id: string, state: string) => ({
  InstanceId: id,
  State: { Name: state },
});

describe("machines-ec2 pack (ADR 0327)", () => {
  it("installs the workflows and a project skill that explains them", () => {
    expect(Object.keys(PACK.files)).toEqual([
      SOURCE,
      ".work/skills/machines-ec2/SKILL.md",
    ]);
    const skill = PACK.files[".work/skills/machines-ec2/SKILL.md"] ?? "";
    expect(skill).toMatch(/^---\nname: machines-ec2\n/);
    // The tag-scoped policy is valid JSON and grants only what it says.
    const policy = JSON.parse(
      /```json\n(\{\n {2}"Version"[\s\S]*?)\n```/.exec(skill)?.[1] ?? "{}",
    );
    expect(
      policy.Statement.map((statement: { Action: string }) => statement.Action),
    ).toEqual([
      "ec2:RunInstances",
      "ec2:RunInstances",
      "ec2:CreateTags",
      "ec2:TerminateInstances",
      "ec2:DescribeInstances",
      "ssm:GetParameters",
    ]);
    expect(PACK.manifest.docs).toContain("@aws-sdk/client-ec2");
    for (const content of [skill, PACK.manifest.docs ?? ""])
      expect(content).not.toMatch(/[–—]/);
  });

  it("binds the server's machine kinds and passes the host's check", () => {
    const parsed = parseProject({ [SOURCE]: recipe });
    expect(parsed.errors).toEqual([]);
    const check = checkProject(
      { [SOURCE]: recipe },
      {
        triggerKinds: MACHINE_TRIGGER_KINDS.map((kind) => ({
          name: kind.name,
          configJsonSchema: kind.configJsonSchema,
          payloadJsonSchema: kind.payloadJsonSchema,
        })),
      },
    );
    expect(check.findings).toEqual([]);
  });

  it("typechecks against the machine kinds and the EC2 client's shapes", async () => {
    const parsed = parseProject({ [SOURCE]: recipe });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ec2-types-"));
    const sources = path.join(
      directory,
      path.dirname(TRIGGER_TYPES_SOURCE_PATH),
    );
    try {
      await fs.mkdir(sources, { recursive: true });
      await fs.writeFile(path.join(directory, SOURCE), recipe);
      await fs.writeFile(
        path.join(directory, TRIGGER_TYPES_SOURCE_PATH),
        renderTriggerTypesModule({
          kinds: MACHINE_TRIGGER_KINDS,
          projectKinds: parsed.triggerKinds,
        }),
      );
      await fs.writeFile(
        path.join(sources, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["node"],
            typeRoots: [path.join(root, "node_modules/@types")],
            paths: {
              "@catamorphic/workflow": [workflowModule],
              "@aws-sdk/client-ec2": [fakeEc2],
            },
          },
          include: ["*.ts"],
        }),
      );
      const result = await promisify(execFile)(
        path.join(root, "node_modules/.bin/tsc"),
        ["--project", path.join(sources, "tsconfig.json")],
        { timeout: 60000 },
      ).catch((error: { stdout?: string; message: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}`);
      });
      expect(result.stdout).toBe("");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("launches with the enrollment's idempotency key, its cloud-init, IMDSv2 and Work's tags", async () => {
    const { result, calls } = await run(`
      answer = () => ({ Instances: [{ InstanceId: "i-0new" }] });
      return createMachine.steps[0].run({ input: ${JSON.stringify(create())} });
    `);
    expect(result).toEqual({ ref: "i-0new" });
    expect(calls).toHaveLength(1);
    const tags = [
      { Key: "work-server", Value: "prod" },
      { Key: "work-machine", Value: "review-1a2b3c-1" },
      { Key: "work-rule", Value: "review" },
      { Key: "work-class", Value: "review" },
      { Key: "Name", Value: "review-1a2b3c-1" },
    ];
    expect(calls[0]).toEqual({
      command: "RunInstances",
      region: "eu-west-1",
      input: {
        ClientToken: KEY,
        ImageId: OPTIONS.image,
        InstanceType: "r7i.2xlarge",
        MinCount: 1,
        MaxCount: 1,
        SubnetId: "subnet-0abc",
        SecurityGroupIds: ["sg-0abc"],
        UserData: Buffer.from(create().enrollment.cloudInit).toString("base64"),
        MetadataOptions: {
          HttpTokens: "required",
          HttpEndpoint: "enabled",
          HttpPutResponseHopLimit: 1,
        },
        BlockDeviceMappings: [
          {
            DeviceName: "/dev/sda1",
            Ebs: {
              VolumeSize: 100,
              VolumeType: "gp3",
              Encrypted: true,
              DeleteOnTermination: true,
            },
          },
        ],
        InstanceInitiatedShutdownBehavior: "terminate",
        TagSpecifications: [
          { ResourceType: "instance", Tags: tags },
          { ResourceType: "volume", Tags: tags },
        ],
      },
    });
    expect(KEY).toHaveLength(64);
  });

  it("asks for Spot only when the class says so", async () => {
    const { calls } = await run(`
      answer = () => ({ Instances: [{ InstanceId: "i-0spot" }] });
      return createMachine.steps[0].run({ input: ${JSON.stringify(create({ ...OPTIONS, market: "spot" }))} });
    `);
    expect(calls[0]?.input).toMatchObject({
      InstanceMarketOptions: {
        MarketType: "spot",
        SpotOptions: {
          SpotInstanceType: "one-time",
          InstanceInterruptionBehavior: "terminate",
        },
      },
    });
  });

  it("answers refused when EC2 launched nothing, and fails on what may have launched", async () => {
    const { result } = await run(`
      const refusals = {};
      for (const code of ["InsufficientInstanceCapacity", "UnauthorizedOperation", "InvalidParameterValue", "VcpuLimitExceeded"]) {
        answer = () => { throw new Ec2Error(code, "no"); };
        refusals[code] = await createMachine.steps[0].run({ input: ${JSON.stringify(create())} });
      }
      const failures = {};
      for (const code of ["RequestLimitExceeded", "InternalError", "IdempotentParameterMismatch"]) {
        answer = () => { throw new Ec2Error(code, "maybe"); };
        failures[code] = await createMachine.steps[0].run({ input: ${JSON.stringify(create())} }).then(() => "answered", (error) => error.name);
      }
      calls.length = 0;
      const invalid = await createMachine.steps[0].run({ input: ${JSON.stringify(create({ region: "eu-west-1" }))} });
      const unknownType = await createMachine.steps[0].run({ input: ${JSON.stringify(create({ ...OPTIONS, instanceType: "r99.huge" }))} });
      const noInstall = await createMachine.steps[0].run({ input: { ...${JSON.stringify(create())}, enrollment: { ...${JSON.stringify(create().enrollment)}, cloudInit: undefined } } });
      return { refusals, failures, invalid, unknownType, noInstall, callsAfterInvalid: calls.length };
    `);
    expect(result).toEqual({
      refusals: {
        InsufficientInstanceCapacity: {
          refused: "InsufficientInstanceCapacity: no",
        },
        UnauthorizedOperation: { refused: "UnauthorizedOperation: no" },
        InvalidParameterValue: { refused: "InvalidParameterValue: no" },
        VcpuLimitExceeded: { refused: "VcpuLimitExceeded: no" },
      },
      failures: {
        RequestLimitExceeded: "RequestLimitExceeded",
        InternalError: "InternalError",
        IdempotentParameterMismatch: "IdempotentParameterMismatch",
      },
      invalid: {
        refused:
          "The class's options need region, instanceType, image and subnetId",
      },
      unknownType: {
        refused: expect.stringContaining("r99.huge is unknown"),
      },
      noInstall: { refused: "This Work server cannot install machines yet" },
      callsAfterInvalid: 0,
    });
  });

  it("terminates by id and by name tag, and is done only once nothing is alive", async () => {
    const destroy = (ref: string | null) =>
      JSON.stringify({
        name: "review-1a2b3c-1",
        class: "review",
        rule: "review",
        ref,
        options: OPTIONS,
      });
    const { result, calls } = await run(`
      // Running: terminated, not done yet.
      answer = ({ command, input }) =>
        command === "DescribeInstances"
          ? { Reservations: [{ Instances: input.InstanceIds ? [${JSON.stringify(instance("i-0aaa", "running"))}] : [${JSON.stringify(instance("i-0aaa", "running"))}, ${JSON.stringify(instance("i-0stray", "pending"))}] }] }
          : {};
      const running = await destroyMachine.steps[0].run({ input: ${destroy("i-0aaa")} });
      // Shutting down: nothing more to terminate, still not done.
      answer = ({ command }) =>
        command === "DescribeInstances" ? { Reservations: [{ Instances: [${JSON.stringify(instance("i-0aaa", "shutting-down"))}] }] } : {};
      const stopping = await destroyMachine.steps[0].run({ input: ${destroy("i-0aaa")} });
      // Terminated, or gone long enough to be unknown: done.
      answer = ({ command, input }) => {
        if (command !== "DescribeInstances") return {};
        if (input.InstanceIds) throw new Ec2Error("InvalidInstanceID.NotFound");
        return { Reservations: [{ Instances: [${JSON.stringify(instance("i-0aaa", "terminated"))}] }] };
      };
      const gone = await destroyMachine.steps[0].run({ input: ${destroy("i-0aaa")} });
      // No ref: a launch whose answer was lost is found by its tags.
      answer = () => ({ Reservations: [] });
      const nothing = await destroyMachine.steps[0].run({ input: ${destroy(null)} });
      return { running, stopping, gone, nothing };
    `);
    expect(result).toEqual({
      running: { done: false },
      stopping: { done: false },
      gone: { done: true },
      nothing: { done: true },
    });
    const terminations = calls.filter(
      (call) => call.command === "TerminateInstances",
    );
    expect(terminations).toEqual([
      {
        command: "TerminateInstances",
        region: "eu-west-1",
        input: { InstanceIds: ["i-0aaa", "i-0stray"] },
      },
    ]);
    expect(calls[1]).toEqual({
      command: "DescribeInstances",
      region: "eu-west-1",
      input: {
        Filters: [
          { Name: "tag:work-machine", Values: ["review-1a2b3c-1"] },
          { Name: "tag:work-class", Values: ["review"] },
          { Name: "tag:work-server", Values: ["prod"] },
          {
            Name: "instance-state-name",
            Values: [
              "pending",
              "running",
              "stopping",
              "stopped",
              "shutting-down",
            ],
          },
        ],
      },
    });
    // Without a ref, only the tags are searched.
    expect(
      calls.filter((call) => call.command === "DescribeInstances").at(-1)
        ?.input,
    ).toMatchObject({ Filters: expect.any(Array) });
  });
});
