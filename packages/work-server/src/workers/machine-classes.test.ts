import { describe, expect, it } from "vitest";
import {
  MachinesConfigSchema,
  machineClassesProblem,
} from "./machine-classes.js";
import { DEFAULT_RETAIN_DAYS, MachineRuleSchema } from "./machine-rules.js";

describe("machine classes (ADR 0204)", () => {
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
        office: { platform: "pool" },
      },
    });
    expect(classes.desk).toMatchObject({ snapshot: false });
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
});
