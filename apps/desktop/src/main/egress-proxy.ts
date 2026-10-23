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

/** An address on this machine's loopback. */
export function isLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || /^127\./.test(name);
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
}: {
  hosts: readonly string[];
  /** Addresses never reachable whatever is declared: Work's own servers. */
  blocked?: (host: string, port: number) => boolean;
  /** A connection the declaration does not allow, for the module's error. */
  onRefused?: (address: string) => void;
}): Promise<EgressProxy> {
  const sockets = new Set<net.Socket>();
  const allowed = (host: string, port: number) =>
    hostAllowed(hosts, host, port) &&
    !blocked(host.toLowerCase(), port) &&
    !(isLoopback(host) && livePorts.has(port));
  const refuse = (address: string) => {
    onRefused?.(address);
  };
  const server = http.createServer((request, response) => {
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
    if (target.protocol !== "http:" || !allowed(target.hostname, port)) {
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
        host: target.hostname,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on("connect", (request, client: net.Socket, head: Buffer) => {
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(request.url ?? "");
    const host = match?.[1];
    const port = Number(match?.[2]);
    if (!host || !allowed(host, port) || sockets.size >= MAX_CONNECTIONS) {
      if (host) refuse(`${host}:${port}`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.setTimeout(IDLE_MS, () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    }
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
        livePorts.delete(port);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
