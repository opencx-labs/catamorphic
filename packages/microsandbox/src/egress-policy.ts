import type { SandboxEgress } from "@catamorphic/sandbox";
import {
  Destination,
  NetworkPolicy,
  type NetworkProfile,
  Rule,
} from "microsandbox";

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

function destinationFor(host: string): Destination {
  // The control plane on this machine's loopback (development) is the
  // VM's host gateway, not the VM's own loopback.
  if (host === "localhost" || host.startsWith("127.") || host === "::1")
    return Destination.group("host");
  if (IPV4.test(host)) return Destination.cidr(`${host}/32`);
  if (host.startsWith("*.")) return Destination.domainSuffix(host.slice(2));
  return Destination.domain(host);
}

/**
 * The microVM network policy for a sandbox's egress (ADR 0176). Open egress
 * keeps the host's configured profiles (or the runtime default). An
 * allowlist denies every other destination; DNS stays reachable so names
 * resolve, and microsandbox matches domain rules against the names the
 * sandbox looked up. Containers inside the VM share its network, so the
 * same policy covers them.
 */
export function microsandboxEgressPolicy(args: {
  egress: SandboxEgress | undefined;
  profiles?: readonly NetworkProfile[];
}): NetworkPolicy | undefined {
  if (!args.egress || args.egress.mode === "open") {
    return args.profiles && args.profiles.length > 0
      ? NetworkPolicy.fromProfiles(args.profiles)
      : undefined;
  }
  return {
    defaultEgress: "deny",
    defaultIngress: "allow",
    rules: [
      Rule.allowDns(),
      ...args.egress.allow.map((host) =>
        Rule.allowEgress(destinationFor(host.toLowerCase())),
      ),
    ],
  };
}
