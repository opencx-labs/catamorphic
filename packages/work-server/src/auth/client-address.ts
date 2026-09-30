import { BlockList, isIP } from "node:net";

/**
 * The header the Work server hands Better Auth the client address in. It is
 * always replaced before a request reaches Better Auth, so a client never
 * chooses its own value.
 */
export const CLIENT_ADDRESS_HEADER = "x-work-client-address";

/**
 * The load balancers and proxies whose `x-forwarded-for` entries the server
 * believes, as IP addresses or CIDR ranges (`WORK_TRUSTED_PROXIES`).
 */
export function trustedProxies(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix, ...rest] = entry.trim().split("/");
    const family = isIP(address);
    const bits = family === 4 ? 32 : 128;
    const length = prefix === undefined ? bits : Number(prefix);
    if (
      family === 0 ||
      rest.length > 0 ||
      (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) ||
      length > bits
    ) {
      throw new Error(
        `Trusted proxies are IP addresses or CIDR ranges, such as 10.0.0.0/8; got '${entry}'`,
      );
    }
    list.addSubnet(address, length, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/**
 * The address of the client behind a request. The hops are the
 * `x-forwarded-for` entries followed by the connection's peer; walking from
 * the nearest, every hop a trusted proxy reports is believed, and the first
 * untrusted hop is the client. With no trusted proxies that is the peer, so
 * a client's own `x-forwarded-for` never changes whose limits it spends.
 */
export function clientAddress(args: {
  peer: string | undefined;
  forwardedFor: string | readonly string[] | undefined;
  trusted: BlockList;
}): string | undefined {
  if (!args.peer || isIP(args.peer) === 0) return undefined;
  const forwarded = (
    typeof args.forwardedFor === "string"
      ? [args.forwardedFor]
      : (args.forwardedFor ?? [])
  )
    .flatMap((header) => header.split(","))
    .map((hop) => hop.trim())
    .filter(Boolean);
  let client = args.peer;
  for (const hop of [...forwarded].reverse()) {
    if (!isTrusted(args.trusted, client)) return client;
    const address = withoutPort(hop);
    // A trusted proxy wrote something that is not an address: the proxy
    // itself is the last hop anyone vouches for.
    if (!address) return client;
    client = address;
  }
  return client;
}

function isTrusted(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}

/** Some proxies write `address:port`, or `[v6]:port`. */
function withoutPort(hop: string): string | undefined {
  if (isIP(hop) !== 0) return hop;
  const bracketed = hop.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1];
  if (bracketed && isIP(bracketed) === 6) return bracketed;
  const v4 = hop.match(/^([\d.]+):\d+$/)?.[1];
  return v4 && isIP(v4) === 4 ? v4 : undefined;
}
