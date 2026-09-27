import { gatewayHostOf, resolveEgress } from "@catamorphic/sandbox";
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

  it("narrows the gateway to its port, the host's loopback included", () => {
    expect(gatewayHostOf("http://localhost:8787/api")).toBe("localhost:8787");
    expect(gatewayHostOf("https://Work.Acme.com")).toBe("work.acme.com:443");
    expect(gatewayHostOf("http://[::1]:3000")).toBe("[::1]:3000");
    const egress = resolveEgress({
      policy: { egress: "gateway" },
      gatewayHosts: [
        gatewayHostOf("http://localhost:8787"),
        gatewayHostOf("https://work.acme.com"),
        gatewayHostOf("http://[fd00::7]:3000"),
      ],
    });
    const policy = microsandboxEgressPolicy({ egress });
    expect(policy?.rules.slice(1)).toEqual(
      [
        [{ kind: "group", group: "host" }, 8787],
        [{ kind: "domain", domain: "work.acme.com" }, 443],
        [{ kind: "cidr", cidr: "fd00::7/128" }, 3000],
      ].map(([destination, port]) => ({
        direction: "egress",
        destination,
        protocols: ["tcp"],
        ports: [{ start: port, end: port }],
        action: "allow",
      })),
    );
  });

  it("matches IPv6 literals as addresses, not names", () => {
    const policy = microsandboxEgressPolicy({
      egress: { mode: "allowlist", allow: ["2001:db8::1", "[2001:db8::2]"] },
    });
    expect(policy?.rules.slice(1).map((rule) => rule.destination)).toEqual([
      { kind: "cidr", cidr: "2001:db8::1/128" },
      { kind: "cidr", cidr: "2001:db8::2/128" },
    ]);
  });
});
