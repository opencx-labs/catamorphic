import {
  type EnvironmentBinding,
  environmentSatisfies,
  resolveEgress,
} from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { sandboxCapabilitiesFor } from "../services/execution-environments-service.js";
import { parseProjectEnvironmentPolicy } from "../services/project-environments-service.js";

describe("Environment images, containers and egress (ADR 0176)", () => {
  it("parses images, containers, egress and approval waits", () => {
    const policy = parseProjectEnvironmentPolicy({
      environments: {
        review: {
          workloads: ["agent"],
          image: ".work/images/review.Dockerfile",
          requirements: { containers: true },
          network: {
            egress: "allowlist",
            allow: ["GitHub.com", "*.npmjs.org"],
          },
          approvals: { waitMinutes: 60 },
        },
        node: {
          workloads: ["agent"],
          image: "node:22-bookworm",
          network: { egress: "gateway" },
        },
        plain: { workloads: ["agent"], image: "Dockerfile" },
      },
    });
    expect(policy.invalid).toBeUndefined();
    expect(policy.environments.review).toMatchObject({
      image: { kind: "dockerfile", path: ".work/images/review.Dockerfile" },
      requirements: { containers: true },
      network: { egress: "allowlist", allow: ["github.com", "*.npmjs.org"] },
      approvals: { waitMinutes: 60 },
    });
    expect(policy.environments.node?.image).toEqual({
      kind: "oci",
      reference: "node:22-bookworm",
    });
    expect(policy.environments.plain?.image).toEqual({
      kind: "dockerfile",
      path: "Dockerfile",
    });
  });

  it.each([
    [{ image: "../outside/Dockerfile" }, "image"],
    [{ image: "has space" }, "image"],
    [{ network: { egress: "allowlist", allow: [] } }, "network.allow"],
    [{ network: { egress: "allowlist", allow: ["https://x.com"] } }, "allow"],
    [{ network: { egress: "gateway-only" } }, "network"],
    [{ network: { egress: "gateway", allow: ["x.com"] } }, "network"],
    [{ requirements: { containers: "yes" } }, "containers"],
    [{ approvals: { waitMinutes: 0 } }, "approvals"],
  ])("rejects %j", (fields, message) => {
    const policy = parseProjectEnvironmentPolicy({
      environments: { bad: { workloads: ["agent"], ...fields } },
    });
    expect(policy.environments.bad).toBeUndefined();
    expect(policy.entries[0]?.invalid?.error).toContain(message);
  });

  it("turns what the sandbox needs into machine capabilities", () => {
    const { environments } = parseProjectEnvironmentPolicy({
      environments: {
        review: {
          workloads: ["agent"],
          image: ".work/images/review.Dockerfile",
          requirements: { containers: true },
          network: { egress: "gateway" },
        },
        open: {
          workloads: ["agent"],
          image: "node:22",
          network: { egress: "open" },
        },
      },
    });
    expect(
      environments.review && sandboxCapabilitiesFor(environments.review),
    ).toEqual(["images", "images.build", "containers", "network.policy"]);
    expect(
      environments.open && sandboxCapabilitiesFor(environments.open),
    ).toEqual(["images"]);
  });

  it("places capability needs only on machines that provide them", () => {
    const machine = (capabilities: string[]): EnvironmentBinding => ({
      id: "node",
      label: "node",
      trust: "managed",
      isolation: "sandbox",
      workloads: ["agent"],
      agentTopologies: ["controller"],
      capabilities,
      resources: {},
    });
    const needs = {
      workload: "agent" as const,
      capabilities: ["images", "containers", "network.policy"],
    };
    // A local-process machine without Docker offers none of them.
    expect(environmentSatisfies(machine(["network.egress"]), needs)).toEqual({
      compatible: false,
      reasons: [
        "Capability 'images' is not available",
        "Capability 'containers' is not available",
        "Capability 'network.policy' is not available",
      ],
    });
    expect(
      environmentSatisfies(
        machine(["network.egress", "images", "network.policy", "containers"]),
        needs,
      ),
    ).toEqual({ compatible: true });
  });

  it("always lets restricted egress reach the gateway", () => {
    expect(
      resolveEgress({
        policy: { egress: "gateway" },
        gatewayHosts: ["work.acme.com"],
      }),
    ).toEqual({ mode: "allowlist", allow: ["work.acme.com"] });
    expect(
      resolveEgress({
        policy: { egress: "allowlist", allow: ["github.com", "work.acme.com"] },
        gatewayHosts: ["work.acme.com"],
      }),
    ).toEqual({ mode: "allowlist", allow: ["work.acme.com", "github.com"] });
    expect(
      resolveEgress({ policy: undefined, gatewayHosts: ["work.acme.com"] }),
    ).toEqual({ mode: "open" });
  });
});
