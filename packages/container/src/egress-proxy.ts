import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** One allowlist entry (ADR 0176), parsed. */
export interface EgressRule {
  kind: "domain" | "suffix" | "ip";
  /** Lowercase; a suffix without its `*.`, an IP normalized. */
  host: string;
  /** Narrows the entry to this TCP port. */
  port?: number;
}

/** What a sandbox's proxy admits: the Environment's allowlist, or anything. */
export type EgressPolicy =
  | { allow: readonly string[] }
  /**
   * Open egress for a sandbox whose nested containers have no route of
   * their own (gVisor has no NAT, ADR 0204).
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
  const valid =
    kind === "ip"
      ? net.isIP(host) !== 0 && !host.includes("%")
      : net.isIP(host) === 0 && validHost(host) !== undefined;
  if (!valid) throw new Error(`'${raw}' is not an egress entry`);
  const number = port === undefined ? undefined : Number(port);
  if (number !== undefined && (number < 1 || number > 65_535))
    throw new Error(`'${raw}' names an invalid port`);
  return {
    kind,
    host: kind === "ip" ? normalizeAddress(host) : host.replace(/\.$/, ""),
    ...(number !== undefined ? { port: number } : {}),
  };
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A host a sandbox may name, lowercase: an IPv4 literal, an IPv6 literal
 * without a zone, or a name of letters, digits and hyphens in dot separated
 * labels whose last label starts with a letter, so no name is an address in
 * disguise (`0x7f.1`). Anything else is undefined: control characters,
 * which the system resolver cuts a name at, spaces, underscores.
 */
export function validHost(raw: string): string | undefined {
  const host = raw.toLowerCase();
  if (net.isIPv4(host)) return host;
  if (net.isIPv6(host)) return host.includes("%") ? undefined : host;
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length === 0 || name.length > 253) return undefined;
  const labels = name.split(".");
  if (!labels.every((label) => LABEL.test(label))) return undefined;
  return /^[a-z]/.test(labels[labels.length - 1] ?? "") ? name : undefined;
}

/** The eight 16-bit words of an IPv6 address. */
function ipv6Words(address: string): number[] {
  // The URL parser writes IPv6 in its one canonical, hexadecimal form.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = "", tail] = canonical.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const gap =
    tail === undefined
      ? []
      : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...gap, ...back].map((word) => Number.parseInt(word, 16));
}

/**
 * An address in one form: IPv4 as is, IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * as the IPv4 address it is, other IPv6 canonical.
 */
export function normalizeAddress(address: string): string {
  if (!net.isIPv6(address)) return address;
  const words = ipv6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

/**
 * Addresses of the machine itself, which no sandbox reaches unless an IP
 * entry names them: loopback (127/8, `::1`), unspecified (0/8, `::`),
 * link-local (169.254/16 with cloud metadata, `fe80::/10`), and IPv6's
 * IPv4-compatible block. `address` is normalized.
 */
export function machineLocal(address: string): boolean {
  if (net.isIPv4(address)) {
    const [first = 0, second = 0] = address.split(".").map(Number);
    return first === 127 || first === 0 || (first === 169 && second === 254);
  }
  const words = ipv6Words(address);
  return (
    words.slice(0, 6).every((word) => word === 0) ||
    ((words[0] ?? 0) & 0xffc0) === 0xfe80
  );
}

function portMatches(rule: EgressRule, port: number): boolean {
  return rule.port === undefined || rule.port === port;
}

/** Whether a valid name (or IP literal) and port are on the allowlist by name. */
export function hostAllowed(
  rules: readonly EgressRule[],
  target: { host: string; port: number },
): boolean {
  const host = target.host.toLowerCase().replace(/\.$/, "");
  const literal = net.isIP(host) !== 0;
  return rules.some((rule) => {
    if (!portMatches(rule, target.port)) return false;
    if (rule.kind === "ip")
      return literal && normalizeAddress(host) === rule.host;
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
  const address = normalizeAddress(target.address);
  return rules.some(
    (rule) =>
      rule.kind === "ip" &&
      rule.host === address &&
      portMatches(rule, target.port),
  );
}

export interface EgressProxy {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Where a request goes, once admitted: an address, never a name. */
export type EgressDecision =
  | { allowed: true; address: string; port: number }
  | { allowed: false; status: number; reason: string };

/** How long a client may take to send its request head. */
const HEAD_TIMEOUT_MS = 30_000;
/** Connections one sandbox may hold open through its proxy at once. */
const MAX_CONNECTIONS = 256;

/**
 * Decide where a request may go (ADR 0204); `host` is valid already. A
 * name is resolved here, once: every address it resolves to is checked,
 * and the connection goes to a checked address. A name on the allowlist
 * (or any name, for an open policy) reaches public addresses. The
 * machine's own addresses ({@link machineLocal}) are reached only when an
 * IP entry names that exact address and port, or, for loopback, when a
 * `localhost` entry names the port. Any other address is reached through
 * an IP entry naming it.
 */
export async function egressDecision(args: {
  rules: readonly EgressRule[];
  any: boolean;
  host: string;
  port: number;
  lookup: EgressLookup;
}): Promise<EgressDecision> {
  const { rules, host, port } = args;
  const literal = net.isIP(host) !== 0;
  const named = args.any || hostAllowed(rules, { host, port });
  const resolved = literal
    ? [host]
    : (await args.lookup(host).catch(() => [])).map((entry) => entry.address);
  const addresses = resolved
    .filter((address) => net.isIP(address) !== 0)
    .map(normalizeAddress);
  if (addresses.length === 0)
    return named
      ? { allowed: false, status: 502, reason: `${host} does not resolve` }
      : refused(host, port);
  const localhost =
    host === "localhost" &&
    rules.some(
      (entry) =>
        entry.kind === "domain" &&
        entry.host === "localhost" &&
        portMatches(entry, port),
    );
  const permitted = addresses.find((address) => {
    if (addressAllowed(rules, { address, port })) return true;
    if (machineLocal(address))
      return localhost && (address.startsWith("127.") || address === "::1");
    return named;
  });
  return permitted
    ? { allowed: true, address: permitted, port }
    : refused(host, port);
}

/**
 * The machine side of a restricted sandbox's only way out (ADR 0204): an
 * HTTP proxy on a Unix socket mounted into the sandbox. It tunnels
 * `CONNECT host:port` and forwards absolute-form plain HTTP requests to
 * what {@link egressDecision} admits, answers 400 to a request it cannot
 * read (a host that is neither a valid name nor an IP literal included),
 * and 403 to a host the policy refuses. It reads one request head per
 * connection, within 30 seconds, and holds at most 256 connections. It
 * speaks just enough HTTP/1.1 for that, on raw sockets, so it runs alike
 * under Bun and Node.
 */
export async function startEgressProxy(args: {
  socketPath: string;
  policy: EgressPolicy;
  lookup?: EgressLookup;
  /** Called for every refused request, for the machine's log. */
  onRefused?: (target: string, reason: string) => void;
  /** Connections held open at once; 256 by default. */
  maxConnections?: number;
  /** How long a request head may take; 30 seconds by default. */
  headTimeoutMs?: number;
}): Promise<EgressProxy> {
  const rules = "allow" in args.policy ? egressRules(args.policy.allow) : [];
  const any = "any" in args.policy;
  const lookup = args.lookup ?? defaultLookup;
  const sockets = new Set<net.Socket>();
  const clients = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    clients.add(client);
    client.once("close", () => {
      clients.delete(client);
      sockets.delete(client);
    });
    client.on("error", () => client.destroy());
    if (clients.size > (args.maxConnections ?? MAX_CONNECTIONS)) {
      answer(client, 503, "Too many connections through this sandbox's proxy");
      return;
    }
    readHead(client, args.headTimeoutMs ?? HEAD_TIMEOUT_MS)
      .then(async (request) => {
        if (!request) return;
        const target = requestTarget(request);
        if ("error" in target) {
          answer(client, 400, target.error);
          return;
        }
        const decision = await egressDecision({
          rules,
          any,
          host: target.host,
          port: target.port,
          lookup,
        });
        // The client may have left while the name resolved.
        if (!clients.has(client)) return;
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
        upstream.on("error", (error) => {
          if (connected || client.destroyed) client.destroy();
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

function refused(host: string, port: number): EgressDecision {
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

/**
 * Read one request head; undefined when the client went away first. A
 * client that sends none within `timeoutMs` is disconnected.
 */
function readHead(
  socket: net.Socket,
  timeoutMs: number,
): Promise<RequestHead | undefined> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      done();
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
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
    socket.once("close", onEnd);
  });
}

/** A port as a request names it: digits only, 1 to 65535. */
function validPort(raw: string): number | undefined {
  if (!/^\d{1,5}$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * Where a proxy request goes: `CONNECT host:port`, or an absolute `http://`
 * URL. The host must be a valid name or IP literal ({@link validHost}),
 * IPv6 in brackets.
 */
export function requestTarget(request: {
  method: string;
  target: string;
}): { host: string; port: number; path: string } | { error: string } {
  if (request.method === "CONNECT") {
    const separator = request.target.lastIndexOf(":");
    const rawHost = request.target.slice(0, Math.max(0, separator));
    const port = validPort(request.target.slice(separator + 1));
    const bracketed = rawHost.match(/^\[([^\]]*)\]$/);
    const host = bracketed
      ? net.isIPv6(bracketed[1] ?? "")
        ? validHost(bracketed[1] ?? "")
        : undefined
      : net.isIPv6(rawHost)
        ? undefined
        : validHost(rawHost);
    if (separator < 0 || port === undefined)
      return { error: "CONNECT needs host:port with a port from 1 to 65535" };
    if (!host) return { error: "CONNECT names an invalid host" };
    return { host, port, path: "" };
  }
  if (!/^http:\/\//i.test(request.target))
    return {
      error:
        "This is an egress proxy: send absolute http:// URLs, or CONNECT for TLS",
    };
  let url: URL;
  try {
    url = new URL(request.target);
  } catch {
    return { error: "Invalid request URL" };
  }
  const host = validHost(url.hostname.replace(/^\[(.*)\]$/, "$1"));
  const port = url.port ? validPort(url.port) : 80;
  if (!host) return { error: "The request names an invalid host" };
  if (port === undefined) return { error: "The request names an invalid port" };
  return { host, port, path: `${url.pathname}${url.search}` };
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
  "host",
]);

/**
 * The request as the origin server sees it: origin-form, its `Host` the
 * admitted host (never one the client chose), without proxy headers, and
 * closing after one response, so every byte on this client connection
 * reaches only the host that was admitted.
 */
function forwardedHead(
  request: RequestHead,
  target: { host: string; port: number; path: string },
): string {
  const headers = request.headers.filter(
    ([name]) => !HOP_BY_HOP.has(name.toLowerCase()),
  );
  const host = `${target.host.includes(":") ? `[${target.host}]` : target.host}${target.port === 80 ? "" : `:${target.port}`}`;
  return `${[
    `${request.method} ${target.path || "/"} ${request.version}`,
    `Host: ${host}`,
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
        : status === 503
          ? "Service Unavailable"
          : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/**
 * The forwarder a sandbox runs with its own Bun or Node: TCP on
 * `<listen>:<port>` piped to the proxy's socket. Arguments: socket path,
 * listen address, port, and a file it writes its pid to once listening.
 * It listens on one address; a sandbox that runs containers starts a
 * second one on its Docker bridge's gateway, never on every address.
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
