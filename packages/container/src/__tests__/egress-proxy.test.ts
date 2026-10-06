import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addressAllowed,
  type EgressLookup,
  type EgressPolicy,
  egressRules,
  hostAllowed,
  requestTarget,
  startEgressProxy,
} from "../egress-proxy.js";

describe("egress rules", () => {
  it("parses domains, suffixes, IPs and ports", () => {
    expect(
      egressRules([
        "GitHub.com",
        "*.npmjs.org",
        "work.acme.com:443",
        "10.0.0.5",
        "10.0.0.6:5432",
        "[FD00::1]:8080",
        "fd00::2",
        "example.com.",
      ]),
    ).toEqual([
      { kind: "domain", host: "github.com" },
      { kind: "suffix", host: "npmjs.org" },
      { kind: "domain", host: "work.acme.com", port: 443 },
      { kind: "ip", host: "10.0.0.5" },
      { kind: "ip", host: "10.0.0.6", port: 5432 },
      { kind: "ip", host: "fd00::1", port: 8080 },
      { kind: "ip", host: "fd00::2" },
      { kind: "domain", host: "example.com" },
    ]);
    expect(() => egressRules(["bad host"])).toThrow("not an egress entry");
    expect(() => egressRules(["a.com:70000"])).toThrow("invalid port");
  });

  it("matches names by domain, suffix and port", () => {
    const rules = egressRules([
      "github.com",
      "*.npmjs.org",
      "work.acme.com:443",
      "10.0.0.5",
      "[fd00::1]:8080",
    ]);
    const allowed = (host: string, port: number) =>
      hostAllowed(rules, { host, port });
    expect(allowed("github.com", 443)).toBe(true);
    expect(allowed("GITHUB.COM.", 80)).toBe(true);
    expect(allowed("api.github.com", 443)).toBe(false);
    expect(allowed("registry.npmjs.org", 443)).toBe(true);
    expect(allowed("a.b.npmjs.org", 443)).toBe(true);
    expect(allowed("npmjs.org", 443)).toBe(false);
    expect(allowed("evilnpmjs.org", 443)).toBe(false);
    expect(allowed("work.acme.com", 443)).toBe(true);
    expect(allowed("work.acme.com", 22)).toBe(false);
    expect(allowed("10.0.0.5", 22)).toBe(true);
    expect(allowed("10.0.0.6", 22)).toBe(false);
    expect(allowed("fd00:0:0::1", 8080)).toBe(true);
    expect(allowed("fd00::1", 8081)).toBe(false);
    // An IP rule never admits a name by its text.
    expect(allowed("10.0.0.5.nip.io", 80)).toBe(false);
  });

  it("admits a resolved address only through an IP rule", () => {
    const rules = egressRules(["github.com", "10.0.0.5:5432"]);
    expect(addressAllowed(rules, { address: "10.0.0.5", port: 5432 })).toBe(
      true,
    );
    expect(addressAllowed(rules, { address: "10.0.0.5", port: 80 })).toBe(
      false,
    );
    expect(addressAllowed(rules, { address: "140.82.112.3", port: 443 })).toBe(
      false,
    );
  });

  it("reads CONNECT and absolute-form targets", () => {
    expect(requestTarget({ method: "CONNECT", target: "a.com:443" })).toEqual({
      host: "a.com",
      port: 443,
      path: "",
    });
    expect(
      requestTarget({ method: "CONNECT", target: "[fd00::1]:8443" }),
    ).toEqual({ host: "fd00::1", port: 8443, path: "" });
    expect(
      requestTarget({ method: "GET", target: "http://A.com/x?y=1" }),
    ).toEqual({ host: "a.com", port: 80, path: "/x?y=1" });
    expect(requestTarget({ method: "GET", target: "/x" })).toHaveProperty(
      "error",
    );
    expect(
      requestTarget({ method: "CONNECT", target: "a.com" }),
    ).toHaveProperty("error");
  });
});

describe("egress proxy", () => {
  let directory: string;
  let origin: http.Server;
  let originPort: number;
  let echo: net.Server;
  let echoPort: number;
  const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-egress-"));
    seen.length = 0;
    origin = http.createServer((request, response) => {
      seen.push({ url: request.url, headers: request.headers });
      response.end(`origin saw ${request.url}`);
    });
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", () => resolve()),
    );
    originPort = portOf(origin);
    echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    echoPort = portOf(echo);
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const names: Record<string, string> = {
    "allowed.test": "127.0.0.1",
    "byip.test": "127.0.0.1",
    "other.test": "127.0.0.1",
    "meta.test": "169.254.169.254",
  };
  const lookup: EgressLookup = async (host) => {
    const address = names[host];
    if (!address) throw new Error(`ENOTFOUND ${host}`);
    return [{ address, family: 4 }];
  };

  async function proxy(policy: EgressPolicy) {
    const refused: string[] = [];
    const started = await startEgressProxy({
      socketPath: path.join(directory, "proxy.sock"),
      policy,
      lookup,
      onRefused: (target) => refused.push(target),
    });
    closers.push(() => started.close());
    return { socketPath: started.socketPath, refused };
  }

  /** Send raw bytes through the proxy socket and collect the reply. */
  function exchange(
    socketPath: string,
    request: string,
    then?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      let reply = "";
      socket.on("data", (chunk) => {
        reply += chunk.toString();
        if (then && reply.includes("200 Connection Established\r\n\r\n")) {
          socket.write(then);
          then = undefined;
        } else if (
          reply.includes("Connection Established") &&
          reply.endsWith("pong")
        )
          socket.end();
      });
      socket.on("end", () => resolve(reply));
      socket.on("close", () => resolve(reply));
      socket.on("error", reject);
      socket.write(request);
    });
  }

  it("forwards absolute-form HTTP to an allowed host, origin-form and closing", async () => {
    const { socketPath } = await proxy({
      allow: [`allowed.test:${originPort}`],
    });
    const reply = await exchange(
      socketPath,
      `GET http://allowed.test:${originPort}/hello?x=1 HTTP/1.1\r\nHost: allowed.test:${originPort}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain("origin saw /hello?x=1");
    expect(seen[0]?.url).toBe("/hello?x=1");
    expect(seen[0]?.headers.connection).toBe("close");
    expect(seen[0]?.headers["proxy-connection"]).toBeUndefined();
  });

  it("tunnels CONNECT to an allowed host", async () => {
    const { socketPath } = await proxy({ allow: ["allowed.test"] });
    const reply = await exchange(
      socketPath,
      `CONNECT allowed.test:${echoPort} HTTP/1.1\r\nHost: allowed.test:${echoPort}\r\n\r\n`,
      "pong",
    );
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\npong");
  });

  it("refuses hosts, ports and addresses the policy does not name", async () => {
    const { socketPath, refused } = await proxy({
      allow: [`allowed.test:${originPort}`, "meta.test"],
    });
    const other = await exchange(
      socketPath,
      `GET http://other.test:${originPort}/ HTTP/1.1\r\n\r\n`,
    );
    expect(other).toMatch(/^HTTP\/1\.1 403/);
    expect(other).toContain("does not allow other.test");
    const wrongPort = await exchange(
      socketPath,
      `CONNECT allowed.test:${echoPort} HTTP/1.1\r\n\r\n`,
    );
    expect(wrongPort).toMatch(/^HTTP\/1\.1 403/);
    const literal = await exchange(
      socketPath,
      `GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\n\r\n`,
    );
    expect(literal).toMatch(/^HTTP\/1\.1 403/);
    // A listed name that resolves to a link-local (metadata) address.
    const metadata = await exchange(
      socketPath,
      "GET http://meta.test/latest HTTP/1.1\r\n\r\n",
    );
    expect(metadata).toMatch(/^HTTP\/1\.1 403/);
    expect(seen).toEqual([]);
    expect(refused).toHaveLength(4);
  });

  it("admits a name whose address an IP entry lists", async () => {
    const { socketPath } = await proxy({ allow: [`127.0.0.1:${originPort}`] });
    const reply = await exchange(
      socketPath,
      `GET http://byip.test:${originPort}/ip HTTP/1.1\r\n\r\n`,
    );
    expect(reply).toContain("origin saw /ip");
  });

  it("answers requests that are not proxy requests with 400", async () => {
    const { socketPath } = await proxy({ allow: ["allowed.test"] });
    const reply = await exchange(socketPath, "GET / HTTP/1.1\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
  });

  it("admits anything under an open policy and removes its socket on close", async () => {
    const started = await startEgressProxy({
      socketPath: path.join(directory, "open.sock"),
      policy: { any: true },
      lookup,
    });
    const reply = await exchange(
      started.socketPath,
      `GET http://other.test:${originPort}/open HTTP/1.1\r\n\r\n`,
    );
    expect(reply).toContain("origin saw /open");
    await started.close();
    expect(fs.existsSync(started.socketPath)).toBe(false);
  });
});

/** The TCP port a listening server took. */
function portOf(server: net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("The server is not listening on TCP");
  return address.port;
}
