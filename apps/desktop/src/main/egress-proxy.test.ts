import http from "node:http";
import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { isLoopback, startEgressProxy } from "./egress-proxy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.headers.host ?? "");
    response.end("fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port.");
  return { port: address.port, hits };
}
async function proxy(input: Parameters<typeof startEgressProxy>[0]) {
  const started = await startEgressProxy(input);
  cleanups.push(started.close);
  return started;
}
function request(port: number, url: string, host?: string) {
  return new Promise<number>((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: url, headers: host ? { host } : {} },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      )
      .on("error", reject);
  });
}
function connect(port: number, target: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let answer = "";
    socket.on("data", (data) => {
      answer += data.toString();
      if (answer.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(answer.split("\r\n")[0] ?? "");
      }
    });
    socket.on("error", reject);
  });
}

it("recognizes unspecified, mapped and ordinary loopback addresses", () => {
  for (const host of [
    "localhost",
    "0.0.0.0",
    "127.0.0.1",
    "127.8.2.3",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:0.0.0.0",
  ])
    expect(isLoopback(host), host).toBe(true);
  expect(isLoopback("192.168.1.2")).toBe(false);
  expect(isLoopback("example.test")).toBe(false);
});

it("refuses a declared 0.0.0.0 route to a blocked Work port", async () => {
  const server = await fixture();
  const gateway = await proxy({
    hosts: [`0.0.0.0:${server.port}`],
    blocked: (host, port) => isLoopback(host) && port === server.port,
  });
  expect(
    await request(
      gateway.port,
      `http://0.0.0.0:${server.port}/api/private`,
      `127.0.0.1:${server.port}`,
    ),
  ).toBe(403);
  expect(await connect(gateway.port, `0.0.0.0:${server.port}`)).toContain(
    "403",
  );
  expect(server.hits).toEqual([]);
});

it("checks resolved addresses for HTTP and CONNECT, including mapped IPv6", async () => {
  const server = await fixture();
  for (const address of ["127.0.0.1", "::ffff:7f00:1", "0.0.0.0"]) {
    const gateway = await proxy({
      hosts: [`allowed.test:${server.port}`],
      lookup: async () => [{ address, family: net.isIP(address) }],
      blocked: (host, port) => isLoopback(host) && port === server.port,
    });
    expect(
      await request(gateway.port, `http://allowed.test:${server.port}/`),
    ).toBe(403);
    expect(
      await connect(gateway.port, `allowed.test:${server.port}`),
    ).toContain("403");
  }
  expect(server.hits).toEqual([]);
});

it("refuses a name when any DNS answer reaches a blocked address", async () => {
  const server = await fixture();
  const gateway = await proxy({
    hosts: [`allowed.test:${server.port}`],
    lookup: async () => [
      { address: "203.0.113.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    blocked: (host, port) => isLoopback(host) && port === server.port,
  });
  expect(
    await request(gateway.port, `http://allowed.test:${server.port}/`),
  ).toBe(403);
  expect(server.hits).toEqual([]);
});

it("pins a permitted DNS answer and forwards the target's own Host", async () => {
  const server = await fixture();
  const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
  const gateway = await proxy({
    hosts: [`fixture.test:${server.port}`],
    lookup,
  });
  expect(
    await request(
      gateway.port,
      `http://fixture.test:${server.port}/`,
      "spoofed.test",
    ),
  ).toBe(200);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(server.hits).toEqual([`fixture.test:${server.port}`]);
  expect(await connect(gateway.port, `fixture.test:${server.port}`)).toContain(
    "200",
  );
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("does not resolve undeclared hosts or reach another module's proxy", async () => {
  const first = await proxy({ hosts: [] });
  const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
  const second = await proxy({ hosts: [`allowed.test:${first.port}`], lookup });
  expect(
    await request(second.port, `http://undeclared.test:${first.port}/`),
  ).toBe(403);
  expect(lookup).not.toHaveBeenCalled();
  expect(await request(second.port, `http://allowed.test:${first.port}/`)).toBe(
    403,
  );
});

it("keeps proxy bookkeeping bounded across a reused upstream connection", async () => {
  const server = await fixture();
  const gateway = await proxy({ hosts: [`127.0.0.1:${server.port}`] });
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    for (let i = 0; i < 40; i++)
      expect(
        await request(gateway.port, `http://127.0.0.1:${server.port}/`),
      ).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      warnings.filter(
        (warning) => warning.name === "MaxListenersExceededWarning",
      ),
    ).toEqual([]);
    expect(server.hits).toHaveLength(40);
  } finally {
    process.off("warning", onWarning);
  }
});
