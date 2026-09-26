import { describe, expect, it } from "vitest";
import { parseProjectEnvironmentPolicy } from "../services/project-environments-service.js";

describe("project Environment policy", () => {
  it("defaults a manifest without Environments to one that selects nothing", () => {
    expect(parseProjectEnvironmentPolicy({ name: "legacy-project" })).toEqual({
      defaultEnvironment: "default",
      environments: {
        default: {
          description: "Run where this host places work",
          workloads: ["agent", "workflow"],
        },
      },
      entries: [
        {
          name: "default",
          definition: {
            description: "Run where this host places work",
            workloads: ["agent", "workflow"],
          },
        },
      ],
    });
  });

  it("parses pools, member devices, and per-Environment requirements", () => {
    expect(
      parseProjectEnvironmentPolicy({
        environments: {
          default: {
            description: "Anywhere",
            workloads: ["agent", "workflow"],
          },
          gpu: {
            workloads: ["agent"],
            pool: { class: "gpu" },
            strict: true,
            requirements: {
              trust: "managed",
              isolation: "sandbox",
              capabilities: ["network.egress"],
              resources: { memoryMb: 8192 },
            },
          },
          mine: { workloads: ["agent"], device: "member" },
        },
        defaultEnvironment: "default",
      }),
    ).toMatchObject({
      defaultEnvironment: "default",
      environments: {
        default: { workloads: ["agent", "workflow"] },
        gpu: {
          pool: { class: "gpu" },
          strict: true,
          requirements: {
            trust: "managed",
            isolation: "sandbox",
            resources: { memoryMb: 8192 },
          },
        },
        mine: { device: "member" },
      },
    });
  });

  it.each([
    [
      "invalid name",
      { environments: { "not allowed": { workloads: ["agent"] } } },
      "Invalid Environment name",
    ],
    [
      "a retired binding",
      { environments: { local: { binding: "local", workloads: ["agent"] } } },
      "binding",
    ],
    [
      "a device and a pool",
      {
        environments: {
          both: { workloads: ["agent"], device: "member", pool: { a: "b" } },
        },
      },
      "not both",
    ],
    [
      "an invalid label name",
      {
        environments: { x: { workloads: ["agent"], pool: { "Big Key": "v" } } },
      },
      "pool",
    ],
    [
      "unsupported workload",
      { environments: { local: { workloads: ["container"] } } },
      "expected one of",
    ],
  ])("reports %s without hiding other entries", (_name, manifest, message) => {
    const parsed = parseProjectEnvironmentPolicy(manifest);
    expect(parsed.entries[0]?.invalid?.error).toContain(message);
  });

  it("rejects a malformed Environments container", () => {
    const parsed = parseProjectEnvironmentPolicy({ environments: null });
    expect(parsed.invalid?.error).toContain("must declare environments");
  });

  it("rejects an unknown default Environment", () => {
    const parsed = parseProjectEnvironmentPolicy({
      environments: { default: { workloads: ["agent"] } },
      defaultEnvironment: "company",
    });
    expect(parsed.invalid?.error).toContain("defaultEnvironment");
  });

  it("parses committed connection bindings (ADR 0172)", () => {
    const parsed = parseProjectEnvironmentPolicy({
      environments: {
        review: {
          workloads: ["agent"],
          pool: { pool: "review" },
          connections: {
            github: {
              provider: "github",
              principal: "service",
              service: "github",
              capabilities: ["get", "post"],
            },
            prod: {
              provider: "prod-replica",
              principal: "service",
              service: "prod-replica",
              capabilities: ["query", "explain", "schema"],
            },
            mail: { provider: "mail", principal: "member" },
            docs: { provider: "docs", principal: "either", service: "docs" },
          },
        },
        default: { workloads: ["agent", "workflow"] },
      },
    });
    expect(parsed.invalid).toBeUndefined();
    expect(parsed.environments.review?.connections).toEqual({
      github: {
        provider: "github",
        principal: "service",
        service: "github",
        capabilities: ["get", "post"],
      },
      prod: {
        provider: "prod-replica",
        principal: "service",
        service: "prod-replica",
        capabilities: ["query", "explain", "schema"],
      },
      mail: { provider: "mail", principal: "member" },
      docs: { provider: "docs", principal: "either", service: "docs" },
    });
    expect(parsed.environments.default?.connections).toBeUndefined();
  });

  it.each([
    [
      "a service binding without a service",
      { provider: "github", principal: "service" },
      "names its service connection",
    ],
    [
      "a member binding naming a service",
      { provider: "mail", principal: "member", service: "mail" },
      "does not name a service connection",
    ],
    [
      "an unknown principal",
      { provider: "mail", principal: "robot" },
      "principal",
    ],
    [
      "an unknown field",
      { provider: "mail", principal: "member", token: "secret" },
      "token",
    ],
    [
      "an invalid service name",
      { provider: "db", principal: "service", service: "Prod DB" },
      "service",
    ],
  ])("reports %s as an invalid Environment", (_name, binding, message) => {
    const parsed = parseProjectEnvironmentPolicy({
      environments: {
        review: { workloads: ["agent"], connections: { alias: binding } },
        default: { workloads: ["agent"] },
      },
    });
    const review = parsed.entries.find((entry) => entry.name === "review");
    expect(review?.invalid?.error).toContain(message);
    expect(parsed.environments.default).toBeDefined();
  });

  it("rejects an invalid connection alias", () => {
    const parsed = parseProjectEnvironmentPolicy({
      environments: {
        review: {
          workloads: ["agent"],
          connections: { "not an alias": { provider: "x", principal: "member" } },
        },
      },
    });
    expect(parsed.entries[0]?.invalid).toBeDefined();
  });
});
