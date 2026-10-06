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
  egressDecision,
  egressRules,
  hostAllowed,
  machineLocal,
  normalizeAddress,
  requestTarget,
  startEgressProxy,
  validHost,
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
        "[::ffff:127.0.0.1]:4700",
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
      { kind: "ip", host: "127.0.0.1", port: 4700 },
    ]);
    for (const entry of ["bad host", "a_b.com", "a\u0000b.com", "*.a\u0000b"])
      expect(() => egressRules([entry])).toThrow("not an egress entry");
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
    expect(
      addressAllowed(rules, { address: "::ffff:10.0.0.5", port: 5432 }),
    ).toBe(true);
    expect(addressAllowed(rules, { address: "10.0.0.5", port: 80 })).toBe(
      false,
    );
    expect(addressAllowed(rules, { address: "140.82.112.3", port: 443 })).toBe(
      false,
    );
  });
});

describe("hosts and addresses", () => {
  it("accepts names and IP literals, nothing else", () => {
    expect(validHost("Registry.NPMJS.org.")).toBe("registry.npmjs.org");
    expect(validHost("localhost")).toBe("localhost");
    expect(validHost("xn--4ca0b.com")).toBe("xn--4ca0b.com");
    expect(validHost("10.0.0.5")).toBe("10.0.0.5");
    expect(validHost("fd00::1")).toBe("fd00::1");
    for (const host of [
      "evil.com\u0000.npmjs.org",
      "evil.com\u0001.npmjs.org",
      "a b.com",
      "a_b.com",
      "-a.com",
      "a-.com",
      "a..com",
      "",
      ".",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(127)}com`,
      "fe80::1%eth0",
      "0x7f.1",
      "127.1",
      "1.2.3.04",
      "2130706433",
    ])
      expect(validHost(host), JSON.stringify(host)).toBeUndefined();
  });

  it("reads CONNECT and absolute-form targets strictly", () => {
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
    // The URL parser writes numeric forms as the address they are.
    expect(
      requestTarget({ method: "GET", target: "http://0x7f.1:8080/" }),
    ).toEqual({ host: "127.0.0.1", port: 8080, path: "/" });
    for (const target of [
      "evil.com\u0000.npmjs.org:443",
      "evil.com\u0000:443",
      "a.com",
      "a.com:",
      "a.com:0",
      "a.com:65536",
      "a.com:+443",
      "a.com:44 3",
      "fd00::1:443",
      "[a.com]:443",
      "[fe80::1%eth0]:443",
      "a_b.com:443",
    ])
      expect(
        requestTarget({ method: "CONNECT", target }),
        JSON.stringify(target),
      ).toHaveProperty("error");
    for (const target of [
      "/x",
      "https://a.com/",
      "http://a\u0000b.com/",
      "http://a_b.com/",
    ])
      expect(
        requestTarget({ method: "GET", target }),
        JSON.stringify(target),
      ).toHaveProperty("error");
  });

  it("normalizes IPv4-mapped IPv6 and knows the machine's own addresses", () => {
    expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAddress("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeAddress("::FFFF:169.254.169.254")).toBe("169.254.169.254");
    expect(normalizeAddress("FD00:0::1")).toBe("fd00::1");
    for (const address of [
      "127.0.0.1",
      "127.255.0.9",
      "0.0.0.0",
      "169.254.169.254",
      "::1",
      "::",
      "fe80::1",
      "febf::1",
      "::127.0.0.1",
    ])
      expect(machineLocal(normalizeAddress(address)), address).toBe(true);
    for (const address of [
      "10.0.0.5",
      "140.82.112.3",
      "169.255.0.1",
      "fd00::1",
      "fec0::1",
      "2001:db8::1",
    ])
      expect(machineLocal(normalizeAddress(address)), address).toBe(false);
  });

  it("checks every address a name resolves to and connects to a checked one", async () => {
    const lookup =
      (addresses: string[]): EgressLookup =>
      async () =>
        addresses.map((address) => ({
          address,
          family: net.isIPv6(address) ? 6 : 4,
        }));
    const decide = (args: {
      allow?: string[];
      host: string;
      port?: number;
      addresses: string[];
    }) =>
      egressDecision({
        rules: egressRules(args.allow ?? []),
        any: args.allow === undefined,
        host: args.host,
        port: args.port ?? 443,
        lookup: lookup(args.addresses),
      });
    // A listed name that resolves to the machine itself, in either mode.
    for (const addresses of [
      ["127.0.0.1"],
      ["::1"],
      ["::ffff:127.0.0.1"],
      ["0.0.0.0"],
      ["::"],
      ["169.254.169.254"],
      ["fe80::1"],
      ["::ffff:169.254.169.254"],
    ]) {
      expect(
        await decide({ allow: ["api.test"], host: "api.test", addresses }),
      ).toMatchObject({ allowed: false, status: 403 });
      expect(await decide({ host: "api.test", addresses })).toMatchObject({
        allowed: false,
        status: 403,
      });
    }
    // Only the public address of a mixed answer is used.
    expect(
      await decide({
        allow: ["api.test"],
        host: "api.test",
        addresses: ["127.0.0.1", "::ffff:140.82.112.3"],
      }),
    ).toEqual({ allowed: true, address: "140.82.112.3", port: 443 });
    // An IP entry naming the exact address and port opens it (the gateway).
    expect(
      await decide({
        allow: ["127.0.0.1:4700"],
        host: "127.0.0.1",
        port: 4700,
        addresses: [],
      }),
    ).toEqual({ allowed: true, address: "127.0.0.1", port: 4700 });
    expect(
      await decide({
        allow: ["127.0.0.1:4700"],
        host: "[::ffff:127.0.0.1]".slice(1, -1),
        port: 4700,
        addresses: [],
      }),
    ).toEqual({ allowed: true, address: "127.0.0.1", port: 4700 });
    expect(
      await decide({
        allow: ["127.0.0.1:4700"],
        host: "127.0.0.1",
        port: 4701,
        addresses: [],
      }),
    ).toMatchObject({ allowed: false });
    expect(
      await decide({
        allow: ["localhost:4700"],
        host: "localhost",
        port: 4700,
        addresses: ["::1", "127.0.0.1"],
      }),
    ).toEqual({ allowed: true, address: "::1", port: 4700 });
    // A literal nobody listed, and a name nobody listed.
    expect(
      await decide({ allow: ["api.test"], host: "10.0.0.5", addresses: [] }),
    ).toMatchObject({ allowed: false, status: 403 });
    expect(
      await decide({
        allow: ["api.test"],
        host: "other.test",
        addresses: ["140.82.112.3"],
      }),
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it("refuses the machine's own names with the system resolver", async () => {
    const decision = await egressDecision({
      rules: [],
      any: true,
      host: "localhost",
      port: 80,
      lookup: (host) =>
        import("node:dns/promises").then((dns) =>
          dns.lookup(host, { all: true, verbatim: true }),
        ),
    });
    expect(decision).toMatchObject({ allowed: false, status: 403 });
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
    "allowed.test": "192.0.2.10",
    "other.test": "192.0.2.11",
    "loop.test": "127.0.0.1",
    "mapped.test": "::ffff:127.0.0.1",
    "meta.test": "169.254.169.254",
  };
  const fakeLookup: EgressLookup = async (host) => {
    const address = names[host];
    if (!address) throw new Error(`ENOTFOUND ${host}`);
    return [{ address, family: net.isIPv6(address) ? 6 : 4 }];
  };

  async function proxy(
    policy: EgressPolicy,
    options?: {
      lookup?: EgressLookup | "system";
      maxConnections?: number;
      headTimeoutMs?: number;
    },
  ) {
    const refused: string[] = [];
    const started = await startEgressProxy({
      socketPath: path.join(directory, "proxy.sock"),
      policy,
      ...(options?.lookup === "system"
        ? {}
        : { lookup: options?.lookup ?? fakeLookup }),
      onRefused: (target) => refused.push(target),
      ...(options?.maxConnections
        ? { maxConnections: options.maxConnections }
        : {}),
      ...(options?.headTimeoutMs
        ? { headTimeoutMs: options.headTimeoutMs }
        : {}),
    });
    closers.push(() => started.close());
    return { socketPath: started.socketPath, refused };
  }

  /** Send raw bytes through the proxy socket and collect the reply. */
  function exchange(
    socketPath: string,
    request: string | Buffer,
    then?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      let reply = "";
      let follow = then;
      socket.on("data", (chunk) => {
        reply += chunk.toString();
        if (follow && reply.includes("200 Connection Established\r\n\r\n")) {
          socket.write(follow);
          follow = undefined;
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

  // The test servers listen on loopback, which the proxy reaches only
  // through an IP entry naming it, as a development gateway does.
  it("forwards absolute-form HTTP to an allowed host, its own Host, closing", async () => {
    const { socketPath } = await proxy({
      allow: [`127.0.0.1:${originPort}`],
    });
    const reply = await exchange(
      socketPath,
      `GET http://loop.test:${originPort}/hello?x=1 HTTP/1.1\r\nHost: evil.test\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain("origin saw /hello?x=1");
    expect(seen[0]?.url).toBe("/hello?x=1");
    expect(seen[0]?.headers.host).toBe(`loop.test:${originPort}`);
    expect(seen[0]?.headers.connection).toBe("close");
    expect(seen[0]?.headers["proxy-connection"]).toBeUndefined();
  });

  it("tunnels CONNECT to an allowed host", async () => {
    const { socketPath } = await proxy({ allow: [`127.0.0.1:${echoPort}`] });
    const reply = await exchange(
      socketPath,
      `CONNECT loop.test:${echoPort} HTTP/1.1\r\nHost: loop.test:${echoPort}\r\n\r\n`,
      "pong",
    );
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\npong");
  });

  it("answers 400 to a host with a control character, before resolving it", async () => {
    // The system resolver would cut `evil.test\0.allowed.test` at the NUL.
    const { socketPath, refused } = await proxy(
      { allow: ["*.allowed.test", `127.0.0.1:${originPort}`] },
      { lookup: "system" },
    );
    for (const host of ["127.0.0.1\u0000.allowed.test", "localhost\u0000.x"]) {
      const connect = await exchange(
        socketPath,
        Buffer.from(`CONNECT ${host}:${originPort} HTTP/1.1\r\n\r\n`, "latin1"),
      );
      expect(connect).toMatch(/^HTTP\/1\.1 400/);
      const absolute = await exchange(
        socketPath,
        Buffer.from(
          `GET http://${host}:${originPort}/ HTTP/1.1\r\n\r\n`,
          "latin1",
        ),
      );
      expect(absolute).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(seen).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("refuses the machine's own addresses even to an open policy", async () => {
    const { socketPath } = await proxy({ any: true }, { lookup: "system" });
    for (const target of [
      `localhost:${originPort}`,
      `127.0.0.1:${originPort}`,
      `[::ffff:127.0.0.1]:${originPort}`,
      `[::1]:${originPort}`,
      `0.0.0.0:${originPort}`,
      "169.254.169.254:80",
    ]) {
      const reply = await exchange(
        socketPath,
        `CONNECT ${target} HTTP/1.1\r\n\r\n`,
      );
      expect(reply, target).toMatch(/^HTTP\/1\.1 403/);
    }
    const absolute = await exchange(
      socketPath,
      `GET http://0x7f.1:${originPort}/ HTTP/1.1\r\n\r\n`,
    );
    expect(absolute).toMatch(/^HTTP\/1\.1 403/);
    expect(seen).toEqual([]);
  });

  it("refuses hosts, ports and addresses the policy does not name", async () => {
    const { socketPath, refused } = await proxy({
      allow: [
        `allowed.test:${originPort}`,
        "meta.test",
        "loop.test",
        "mapped.test",
      ],
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
    // Listed names that resolve to the machine itself.
    for (const name of ["meta.test", "loop.test", "mapped.test"]) {
      const reply = await exchange(
        socketPath,
        `GET http://${name}:${originPort}/ HTTP/1.1\r\n\r\n`,
      );
      expect(reply, name).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(seen).toEqual([]);
    expect(refused).toHaveLength(6);
  });

  it("reaches loopback through an IP entry naming it, by address or name", async () => {
    const { socketPath } = await proxy({
      allow: [`127.0.0.1:${originPort}`],
    });
    const byAddress = await exchange(
      socketPath,
      `GET http://127.0.0.1:${originPort}/ip HTTP/1.1\r\n\r\n`,
    );
    expect(byAddress).toContain("origin saw /ip");
    const byName = await exchange(
      socketPath,
      `GET http://loop.test:${originPort}/named HTTP/1.1\r\n\r\n`,
    );
    expect(byName).toContain("origin saw /named");
  });

  it("answers 400 to requests that are not proxy requests", async () => {
    const { socketPath } = await proxy({ allow: ["allowed.test"] });
    const reply = await exchange(socketPath, "GET / HTTP/1.1\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
  });

  it("drops a client that sends no request head in time", async () => {
    const { socketPath } = await proxy(
      { allow: ["allowed.test"] },
      { headTimeoutMs: 100 },
    );
    const started = Date.now();
    const reply = await exchange(socketPath, "CONNECT allowed.te");
    expect(reply).toBe("");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("holds a bounded number of connections", async () => {
    const { socketPath } = await proxy(
      { allow: ["allowed.test"] },
      { maxConnections: 2 },
    );
    const held = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<net.Socket>((resolve) => {
            const socket = net.connect(socketPath, () => resolve(socket));
          }),
      ),
    );
    try {
      const reply = await exchange(
        socketPath,
        "CONNECT a.test:443 HTTP/1.1\r\n\r\n",
      );
      expect(reply).toMatch(/^HTTP\/1\.1 503/);
    } finally {
      for (const socket of held) socket.destroy();
    }
  });

  it("does not connect for a client that left while its name resolved", async () => {
    let release: () => void = () => {};
    const resolving = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = false;
    const connections: net.Socket[] = [];
    echo.on("connection", (socket) => connections.push(socket));
    const { socketPath } = await proxy(
      { allow: [`127.0.0.1:${echoPort}`, "slow.test"] },
      {
        lookup: async () => {
          asked = true;
          await resolving;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      },
    );
    const client = net.connect(socketPath);
    const closed = new Promise((resolve) => client.once("close", resolve));
    client.write(`CONNECT slow.test:${echoPort} HTTP/1.1\r\n\r\n`);
    await vitestPoll(() => asked);
    client.destroy();
    await closed;
    release();
    // A later request connects: by its answer the first had its turn.
    const later = await exchange(
      socketPath,
      `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`,
      "pong",
    );
    expect(later).toContain("pong");
    expect(connections).toHaveLength(1);
  });

  it("refuses loopback to an open policy and removes its socket on close", async () => {
    const started = await startEgressProxy({
      socketPath: path.join(directory, "open.sock"),
      policy: { any: true },
      lookup: fakeLookup,
    });
    const reply = await exchange(
      started.socketPath,
      `GET http://loop.test:${originPort}/open HTTP/1.1\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    await started.close();
    expect(fs.existsSync(started.socketPath)).toBe(false);
  });
});

/** Wait for a condition, polling with a deadline. */
async function vitestPoll(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The TCP port a listening server took. */
function portOf(server: net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("The server is not listening on TCP");
  return address.port;
}
