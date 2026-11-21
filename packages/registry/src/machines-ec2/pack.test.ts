import { describe, expect, it } from "vitest";
import { packFiles } from "../pack-files.js";

describe("machine recipes (ADR 0347)", () => {
  const recipes = [
    "machines-ec2",
    "machines-hetzner",
    "machines-install",
    "machines-policies",
    "machines-workflows",
  ];
  it.each(recipes)("installs %s as Work server host code", (name) => {
    const pack = packFiles(name);
    expect(Object.keys(pack.files)).toEqual([
      `machines/${name}.ts`,
      `machines/${name}.md`,
    ]);
    expect(pack.files[`machines/${name}.ts`]).toContain("export function");
    expect(pack.files[`machines/${name}.md`]).toContain(`name: ${name}`);
  });

  it("documents launch-tag and resource-tag restrictions for the EC2 role", () => {
    const skill = packFiles("machines-ec2").files["machines/machines-ec2.md"];
    for (const action of [
      "ec2:RunInstances",
      "ec2:CreateTags",
      "ec2:DescribeInstances",
      "ec2:TerminateInstances",
      "ec2:StopInstances",
      "ec2:StartInstances",
    ]) {
      expect(skill).toContain(action);
    }
    expect(skill).toContain("aws:RequestTag/work-server");
    expect(skill).toContain("aws:ResourceTag/work-server");
  });
});
