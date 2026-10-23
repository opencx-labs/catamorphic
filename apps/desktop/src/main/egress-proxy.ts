import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { hostAllowed } from "../shared/code-access.js";

/** Connections one module may hold open through its proxy at once. */
const MAX_CONNECTIONS = 64;
const IDLE_MS = 120_000;
/** Request headers that describe the hop to the proxy, not the request. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Every module's proxy port: no module reaches another's way out. */
const livePorts = new Set<number>();
const localAddresses = new net.BlockList();
localAddresses.addSubnet("127.0.0.0", 8, "ipv4");
localAddresses.addAddress("0.0.0.0", "ipv4");
localAddresses.addAddress("::1", "ipv6");
localAddresses.addAddress("::", "ipv6");

/** An address on this machine's loopback. */
export function isLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  const family = net.isIP(name);
  return (
    name === "localhost" ||
    (family !== 0 && localAddresses.check(name, family === 6 ? "ipv6" : "ipv4"))
  );
}

export interface EgressProxy {
  /** The loopback port, the only address the module's sandbox may reach. */
  port: number;
  close: () => Promise<void>;
}

/**
 * A confined module's whole network (ADR 0277): a proxy on loopback for its
 * process alone, opening connections only to the hosts its access declares.
 * The sandbox lets the process reach this port and nothing else, so code
 * that ignores the proxy reaches nothing; names resolve here, so the module
 * has no DNS of its own either. HTTPS is tunneled (CONNECT) and plain HTTP
 * forwarded; anything else is refused.
 */
export async function startEgressProxy({
  hosts,
  blocked = () => false,
  onRefused,
  lookup = (host) => dns.lookup(host, { all: true, verbatim: true }),
}: {
  hosts: readonly string[];
  /** Addresses never reachable whatever is declared: Work's own servers. */
  blocked?: (host: string, port: number) => boolean;
  /** A connection the declaration does not allow, for the module's error. */
  onRefused?: (address: string) => void;
  /** Resolve once; connections use the checked address rather than resolving again. */
  lookup?: (
    host: string,
  ) => Promise<readonly { address: string; family: number }[]>;
}): Promise<EgressProxy> {
  const sockets = new Set<net.Socket>();
  let closed = false;
  const forbidden = (host: string, port: number) =>
    blocked(host.toLowerCase(), port) ||
    (isLoopback(host) && livePorts.has(port));
  const destination = async (host: string, port: number) => {
    if (
      closed ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !hostAllowed(hosts, host, port) ||
      forbidden(host, port)
    )
      return null;
    const family = net.isIP(host);
    const addresses = family
      ? [{ address: host, family }]
      : await lookup(host).catch(() => []);
    if (
      closed ||
      !addresses.length ||
      addresses.some(
        ({ address }) => net.isIP(address) === 0 || forbidden(address, port),
      )
    )
      return null;
    // Prefer IPv4 when both are available, including local services bound to 127.0.0.1.
    return (
      addresses.find((entry) => entry.family === 4) ?? addresses[0] ?? null
    );
  };
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    if (closed) socket.destroy();
  };
  const refuse = (address: string) => {
    onRefused?.(address);
  };
  const server = http.createServer(async (request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const port = Number(
      target.port || (target.protocol === "https:" ? 443 : 80),
    );
    const address =
      target.protocol === "http:" && sockets.size <= MAX_CONNECTIONS
        ? await destination(target.hostname, port)
        : null;
    if (request.destroyed || response.destroyed || closed) return;
    if (!address) {
      refuse(`${target.hostname}:${port}`);
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(
        `This module's access does not reach ${target.hostname}; add it to hosts.`,
      );
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => !HOP_HEADERS.has(name.toLowerCase()),
      ),
    );
    const upstream = http.request(
      {
        host: address.address,
        family: address.family,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("socket", track);
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on("connect", async (request, client: net.Socket, head: Buffer) => {
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(request.url ?? "");
    const host = match?.[1];
    const port = Number(match?.[2]);
    const address =
      host && sockets.size <= MAX_CONNECTIONS
        ? await destination(host, port)
        : null;
    if (client.destroyed || closed) return;
    if (!address) {
      if (host) refuse(`${host}:${port}`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(
      { port, host: address.address, family: address.family },
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      },
    );
    for (const socket of [client, upstream]) {
      track(socket);
    }
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  server.on("connection", (socket) => {
    if (sockets.size >= MAX_CONNECTIONS) socket.destroy();
    else track(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The module's network could not start.");
  }
  const port = address.port;
  livePorts.add(port);
  let closing: Promise<void> | undefined;
  return {
    port,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        closed = true;
        livePorts.delete(port);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
