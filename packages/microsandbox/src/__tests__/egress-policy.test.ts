import { describe, expect, it } from "vitest";
import { microsandboxEgressPolicy } from "../egress-policy.js";

describe("microsandboxEgressPolicy (ADR 0176)", () => {
  it("keeps the host's profiles, or the runtime default, for open egress", () => {
    expect(microsandboxEgressPolicy({ egress: { mode: "open" } })).toBe(
      undefined,
    );
    expect(microsandboxEgressPolicy({ egress: undefined })).toBe(undefined);
    const profiles = microsandboxEgressPolicy({
      egress: { mode: "open" },
      profiles: ["public", "host"],
    });
    expect(profiles?.defaultEgress).toBe("deny");
    expect(profiles?.rules.length).toBeGreaterThan(1);
  });

  it("denies everything but DNS and the allowlist", () => {
    const policy = microsandboxEgressPolicy({
      egress: {
        mode: "allowlist",
        allow: ["work.example.com", "*.npmjs.org", "10.0.0.7", "127.0.0.1"],
      },
      // A restricted Environment never inherits the host's broader profiles.
      profiles: ["public", "private", "host"],
    });
    expect(policy).toEqual({
      defaultEgress: "deny",
      defaultIngress: "allow",
      rules: [
        {
          direction: "egress",
          destination: { kind: "group", group: "host" },
          protocols: ["udp", "tcp"],
          ports: [{ start: 53, end: 53 }],
          action: "allow",
        },
        ...[
          { kind: "domain", domain: "work.example.com" },
          { kind: "domainSuffix", suffix: "npmjs.org" },
          { kind: "cidr", cidr: "10.0.0.7/32" },
          { kind: "group", group: "host" },
        ].map((destination) => ({
          direction: "egress",
          destination,
          protocols: [],
          ports: [],
          action: "allow",
        })),
      ],
    });
  });

  it("denies everything but DNS when only the gateway is allowed and none is known", () => {
    const policy = microsandboxEgressPolicy({
      egress: { mode: "allowlist", allow: [] },
    });
    expect(policy?.rules).toHaveLength(1);
  });
});
