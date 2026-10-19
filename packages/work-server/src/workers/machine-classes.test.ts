import { describe, expect, it } from "vitest";
import {
  MachinesConfigSchema,
  machineClassesProblem,
} from "./machine-classes.js";
import { DEFAULT_RETAIN_DAYS, MachineRuleSchema } from "./machine-rules.js";

describe("machine classes (ADR 0205)", () => {
  it("names what a server lacks for its classes", () => {
    const { classes } = MachinesConfigSchema.parse({
      classes: {
        desk: {
          platform: "hetzner-cloud",
          serverType: "cpx41",
          location: "fsn1",
          image: "ubuntu-24.04",
        },
        lab: { platform: "custom" },
        review: {
          platform: "custom",
          options: { instanceType: "m7i.4xlarge", subnets: ["a", "b"] },
        },
        office: { platform: "pool" },
      },
    });
    expect(classes.desk).toMatchObject({ snapshot: false });
    // The provisioner's own options pass through as written (ADR 0258).
    expect(classes.review).toEqual({
      platform: "custom",
      options: { instanceType: "m7i.4xlarge", subnets: ["a", "b"] },
    });
    expect(
      machineClassesProblem({
        classes,
        hetznerToken: false,
        provisioner: true,
      }),
    ).toContain("WORK_HETZNER_TOKEN");
    expect(
      machineClassesProblem({
        classes,
        hetznerToken: true,
        provisioner: false,
      }),
    ).toContain("machineProvisioner");
    expect(
      machineClassesProblem({ classes, hetznerToken: true, provisioner: true }),
    ).toBeUndefined();
    expect(
      machineClassesProblem({
        classes: { office: { platform: "pool" } },
        hetznerToken: false,
        provisioner: false,
      }),
    ).toBeUndefined();
  });

  it("refuses class names rules could not name, and Work's own labels", () => {
    for (const classes of [
      { "": { platform: "pool" } },
      { "-desk": { platform: "pool" } },
      // Rule and class names end up in host names and cloud labels.
      { "desk-": { platform: "pool" } },
      { [`d${"e".repeat(31)}`]: { platform: "pool" } },
      {
        desk: {
          platform: "hetzner-cloud",
          serverType: "cpx41",
          location: "fsn1",
          image: "ubuntu-24.04",
          labels: { "work-server-id": "1" },
        },
      },
      {
        desk: {
          platform: "hetzner-cloud",
          serverType: "cpx41",
          location: "fsn1",
          image: "ubuntu-24.04",
          token: "never here",
        },
      },
    ])
      expect(MachinesConfigSchema.safeParse({ classes }).success).toBe(false);
  });
});

describe("machine rules", () => {
  it("keep released machines for seven days unless told otherwise", () => {
    const base = {
      group: "Eng@Example.com",
      machines: "each-member",
      class: "desk",
    };
    expect(MachineRuleSchema.parse(base)).toEqual({
      group: "eng@example.com",
      machines: "each-member",
      class: "desk",
      labels: {},
      trusted: false,
      retainDays: DEFAULT_RETAIN_DAYS,
    });
    expect(MachineRuleSchema.parse({ ...base, retainDays: 0 }).retainDays).toBe(
      0,
    );
    expect(
      MachineRuleSchema.parse({ ...base, retainDays: 365 }).retainDays,
    ).toBe(365);
    for (const retainDays of [-1, 1.5, 366, "7"])
      expect(MachineRuleSchema.safeParse({ ...base, retainDays }).success).toBe(
        false,
      );
    expect(
      MachineRuleSchema.safeParse({ ...base, machines: { shared: 0 } }).success,
    ).toBe(false);
  });

  it("scale machines on demand for a group or for projects, keeping none once idle", () => {
    const project = "0f6a2c55-5b0b-4d64-9b4a-6c1f5a1f4f0e";
    expect(
      MachineRuleSchema.parse({
        projects: [project],
        machines: { demand: { max: 9 } },
        class: "review",
      }),
    ).toEqual({
      projects: [project],
      machines: {
        demand: { max: 9, min: 0, idleMinutes: 10, enrollMinutes: 15 },
      },
      class: "review",
      labels: {},
      trusted: false,
      retainDays: 0,
    });
    expect(
      MachineRuleSchema.safeParse({
        group: "eng@example.com",
        machines: { demand: { max: 2, min: 1, idleMinutes: 30 } },
        class: "review",
      }).success,
    ).toBe(true);
    for (const rule of [
      { machines: { demand: { max: 2 } }, class: "review" },
      {
        group: "eng@example.com",
        projects: [project],
        machines: { demand: { max: 2 } },
        class: "review",
      },
      { projects: [project], machines: "each-member", class: "review" },
      {
        projects: [project],
        machines: { demand: { max: 0 } },
        class: "review",
      },
      {
        projects: [project],
        machines: { demand: { max: 2, idleMinutes: 0 } },
        class: "review",
      },
      {
        projects: ["not-a-project"],
        machines: { demand: { max: 2 } },
        class: "review",
      },
    ])
      expect(
        MachineRuleSchema.safeParse(rule).success,
        JSON.stringify(rule),
      ).toBe(false);
  });
});
