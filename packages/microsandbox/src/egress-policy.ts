import type { SandboxEgress } from "@catamorphic/sandbox";
import {
  Destination,
  NetworkPolicy,
  type NetworkProfile,
  PortRange,
  Rule,
} from "microsandbox";

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

/** An allowlist entry: a host, optionally `:port` (IPv6 in brackets). */
function parseEntry(entry: string): { host: string; port?: number } {
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed)
    return {
      host: bracketed[1] ?? "",
      ...(bracketed[2] ? { port: Number(bracketed[2]) } : {}),
    };
  const withPort = entry.match(/^([^:]+):(\d{1,5})$/);
  if (withPort) return { host: withPort[1] ?? "", port: Number(withPort[2]) };
  return { host: entry };
}

function destinationFor(host: string): Destination {
  // The control plane on this machine's loopback (development) is the
  // VM's host gateway, not the VM's own loopback. The group is every
  // service on the host, so a gateway entry narrows it to its port.
  if (host === "localhost" || host.startsWith("127.") || host === "::1")
    return Destination.group("host");
  if (IPV4.test(host)) return Destination.cidr(`${host}/32`);
  if (host.includes(":")) return Destination.cidr(`${host}/128`);
  if (host.startsWith("*.")) return Destination.domainSuffix(host.slice(2));
  return Destination.domain(host);
}

function allowRule(entry: string): Rule {
  const { host, port } = parseEntry(entry);
  const rule = Rule.allowEgress(destinationFor(host));
  return port === undefined
    ? rule
    : { ...rule, protocols: ["tcp"], ports: [PortRange.single(port)] };
}

/**
 * The microVM network policy for a sandbox's egress (ADR 0176). Open egress
 * keeps the host's configured profiles (or the runtime default). An
 * allowlist denies every other destination; DNS stays reachable so names
 * resolve, and microsandbox matches domain rules against the names the
 * sandbox looked up. An entry with a port (the gateway's) reaches only that
 * TCP port. Containers inside the VM share its network, so the same policy
 * covers them.
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
      ...args.egress.allow.map((entry) => allowRule(entry.toLowerCase())),
    ],
  };
}
