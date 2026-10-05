import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** One allowlist entry (ADR 0176), parsed. */
export interface EgressRule {
  kind: "domain" | "suffix" | "ip";
  /** Lowercase; a suffix without its `*.`, an IP without brackets. */
  host: string;
  /** Narrows the entry to this TCP port. */
  port?: number;
}

/** What a sandbox's proxy admits: the Environment's allowlist, or anything. */
export type EgressPolicy =
  | { allow: readonly string[] }
  /**
   * Open egress for a sandbox whose nested containers have no route of
   * their own (gVisor has no NAT, ADR 0203).
   */
  | { any: true };

/** Resolves a name to addresses, as `dns.lookup` with `all: true` does. */
export type EgressLookup = (
  host: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const defaultLookup: EgressLookup = (host) =>
  dns.lookup(host, { all: true, verbatim: true });

/** Parse allowlist entries: `host`, `host:443`, `*.suffix`, `1.2.3.4`, `[fd00::1]:8080`. */
export function egressRules(allow: readonly string[]): EgressRule[] {
  return allow.map((raw) => {
    const entry = raw.trim().toLowerCase();
    const bracketed = entry.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (bracketed) return rule("ip", bracketed[1] ?? "", bracketed[2], raw);
    if (net.isIPv6(entry)) return rule("ip", entry, undefined, raw);
    const withPort = entry.match(/^([^:]+):(\d{1,5})$/);
    const host = withPort ? (withPort[1] ?? "") : entry;
    const port = withPort ? withPort[2] : undefined;
    if (net.isIPv4(host)) return rule("ip", host, port, raw);
    if (host.startsWith("*.")) return rule("suffix", host.slice(2), port, raw);
    return rule("domain", host, port, raw);
  });
}

function rule(
  kind: EgressRule["kind"],
  host: string,
  port: string | undefined,
  raw: string,
): EgressRule {
  if (!host || host.includes("*") || /\s/.test(host))
    throw new Error(`'${raw}' is not an egress entry`);
  const number = port === undefined ? undefined : Number(port);
  if (number !== undefined && (number < 1 || number > 65_535))
    throw new Error(`'${raw}' names an invalid port`);
  return {
    kind,
    host: kind === "ip" ? canonicalIp(host) : host.replace(/\.$/, ""),
    ...(number !== undefined ? { port: number } : {}),
  };
}

function canonicalIp(address: string): string {
  if (!net.isIPv6(address)) return address;
  // The URL parser writes IPv6 in its one canonical form.
  return new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

function portMatches(rule: EgressRule, port: number): boolean {
  return rule.port === undefined || rule.port === port;
}

/** Whether a name (or IP literal) and port are on the allowlist by name. */
export function hostAllowed(
  rules: readonly EgressRule[],
  target: { host: string; port: number },
): boolean {
  const host = target.host.toLowerCase().replace(/\.$/, "");
  const literal = net.isIP(host) !== 0;
  return rules.some((rule) => {
    if (!portMatches(rule, target.port)) return false;
    if (rule.kind === "ip") return literal && canonicalIp(host) === rule.host;
    if (literal) return false;
    if (rule.kind === "domain") return host === rule.host;
    return host.endsWith(`.${rule.host}`);
  });
}

/** Whether an address a name resolved to is allowed by an IP entry. */
export function addressAllowed(
  rules: readonly EgressRule[],
  target: { address: string; port: number },
): boolean {
  const address = canonicalIp(target.address);
  return rules.some(
    (rule) =>
      rule.kind === "ip" &&
      rule.host === address &&
      portMatches(rule, target.port),
  );
}

/** Link-local (cloud metadata) addresses: reached only when listed by IP. */
function linkLocal(address: string): boolean {
  return address.startsWith("169.254.") || /^fe[89ab]/i.test(address);
}

export interface EgressProxy {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Where a request goes, once admitted. */
type Decision =
  | { allowed: true; address: string; port: number }
  | { allowed: false; status: number; reason: string };

/**
 * The machine side of a restricted sandbox's only way out (ADR 0203): an
 * HTTP proxy on a Unix socket mounted into the sandbox. It tunnels
 * `CONNECT host:port` and forwards absolute-form plain HTTP requests to
 * the hosts the policy admits, resolving names itself, and answers 403 to
 * everything else. It speaks just enough HTTP/1.1 to read one request head
 * per connection, on raw sockets, so it runs alike under Bun and Node.
 */
export async function startEgressProxy(args: {
  socketPath: string;
  policy: EgressPolicy;
  lookup?: EgressLookup;
  /** Called for every refused request, for the machine's log. */
  onRefused?: (target: string, reason: string) => void;
}): Promise<EgressProxy> {
  const rules = "allow" in args.policy ? egressRules(args.policy.allow) : [];
  const any = "any" in args.policy;
  const lookup = args.lookup ?? defaultLookup;
  const sockets = new Set<net.Socket>();

  const decide = async (host: string, port: number): Promise<Decision> => {
    const literal = net.isIP(host) !== 0;
    const named = any || hostAllowed(rules, { host, port });
    const addresses = literal
      ? [{ address: host }]
      : await lookup(host).catch(() => []);
    if (addresses.length === 0)
      return named
        ? { allowed: false, status: 502, reason: `${host} does not resolve` }
        : refused(host, port);
    if (named) {
      const usable = addresses.find(
        (entry) =>
          any ||
          !linkLocal(entry.address) ||
          addressAllowed(rules, { address: entry.address, port }),
      );
      return usable
        ? { allowed: true, address: usable.address, port }
        : refused(host, port);
    }
    const listed = addresses.find((entry) =>
      addressAllowed(rules, { address: entry.address, port }),
    );
    return listed
      ? { allowed: true, address: listed.address, port }
      : refused(host, port);
  };

  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    readHead(client)
      .then(async (request) => {
        if (!request) return;
        const target = requestTarget(request);
        if ("error" in target) {
          answer(client, 400, target.error);
          return;
        }
        const decision = await decide(target.host, target.port);
        if (!decision.allowed) {
          args.onRefused?.(`${target.host}:${target.port}`, decision.reason);
          answer(client, decision.status, decision.reason);
          return;
        }
        const upstream = net.connect({
          host: decision.address,
          port: decision.port,
        });
        sockets.add(upstream);
        let connected = false;
        upstream.once("close", () => sockets.delete(upstream));
        upstream.once("error", (error) => {
          if (connected) client.destroy();
          else answer(client, 502, `${target.host}: ${error.message}`);
        });
        client.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
          connected = true;
          if (request.method === "CONNECT") {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          } else {
            upstream.write(forwardedHead(request, target));
          }
          if (request.rest.length > 0) upstream.write(request.rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
      })
      .catch(() => client.destroy());
  });

  fs.mkdirSync(path.dirname(args.socketPath), { recursive: true });
  fs.rmSync(args.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The sandbox's user may be anyone; the directory is the sandbox's own.
  fs.chmodSync(args.socketPath, 0o666);
  return {
    socketPath: args.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        fs.rmSync(args.socketPath, { force: true });
      }),
  };
}

function refused(host: string, port: number): Decision {
  return {
    allowed: false,
    status: 403,
    reason: `The Environment's egress policy does not allow ${host}:${port}`,
  };
}

interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Array<[string, string]>;
  /** Bytes after the head: the start of a body or of a tunnel. */
  rest: Buffer;
}

const MAX_HEAD_BYTES = 64 * 1024;

/** Read one request head; undefined when the client went away first. */
function readHead(socket: net.Socket): Promise<RequestHead | undefined> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const done = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
    };
    const onEnd = () => {
      done();
      resolve(undefined);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_HEAD_BYTES) {
          done();
          reject(new Error("Request head too large"));
        }
        return;
      }
      done();
      socket.pause();
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const [method = "", target = "", version = "HTTP/1.1"] = (
        lines[0] ?? ""
      ).split(" ");
      resolve({
        method: method.toUpperCase(),
        target,
        version,
        headers: lines.slice(1).flatMap((line): Array<[string, string]> => {
          const colon = line.indexOf(":");
          return colon > 0
            ? [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()]]
            : [];
        }),
        rest: Buffer.from(buffered.subarray(end + 4)),
      });
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
  });
}

/** Where a proxy request goes: `CONNECT host:port`, or an absolute `http://` URL. */
export function requestTarget(request: {
  method: string;
  target: string;
}): { host: string; port: number; path: string } | { error: string } {
  if (request.method === "CONNECT") {
    const match = request.target.match(
      /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/,
    );
    const host = match?.[1] ?? match?.[2];
    const port = Number(match?.[3]);
    if (!host || !(port >= 1 && port <= 65_535))
      return { error: "CONNECT needs host:port" };
    return { host: host.toLowerCase(), port, path: "" };
  }
  if (!/^http:\/\//i.test(request.target))
    return {
      error:
        "This is an egress proxy: send absolute http:// URLs, or CONNECT for TLS",
    };
  try {
    const url = new URL(request.target);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return {
      host,
      port: Number(url.port || 80),
      path: `${url.pathname}${url.search}`,
    };
  } catch {
    return { error: "Invalid request URL" };
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * The request as the origin server sees it: origin-form, without proxy
 * headers, and closing after one response, so every byte on this client
 * connection reaches only the host that was admitted.
 */
function forwardedHead(
  request: RequestHead,
  target: { host: string; port: number; path: string },
): string {
  const headers = request.headers.filter(
    ([name]) => !HOP_BY_HOP.has(name.toLowerCase()),
  );
  const host = headers.some(([name]) => name.toLowerCase() === "host")
    ? []
    : [
        `Host: ${target.host.includes(":") ? `[${target.host}]` : target.host}${target.port === 80 ? "" : `:${target.port}`}`,
      ];
  return `${[
    `${request.method} ${target.path || "/"} ${request.version}`,
    ...host,
    ...headers.map(([name, value]) => `${name}: ${value}`),
    "Connection: close",
  ].join("\r\n")}\r\n\r\n`;
}

function answer(socket: net.Socket, status: number, reason: string): void {
  const body = `${reason}\n`;
  const text =
    status === 403
      ? "Forbidden"
      : status === 400
        ? "Bad Request"
        : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/**
 * The forwarder a restricted sandbox runs with its own Bun or Node: TCP on
 * `<listen>:<port>` piped to the proxy's socket. Arguments: socket path,
 * listen address, port, and a file it writes its pid to once listening.
 */
export const FORWARDER_SOURCE = `import fs from "node:fs";
import net from "node:net";
const [socketPath, host, port, ready] = process.argv.slice(2);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.listen(Number(port), host, () =>
  fs.writeFileSync(ready, String(process.pid)),
);
`;
