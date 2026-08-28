import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevStartupAttemptError,
  devListenerPorts,
  devPortAllocatorLockPath,
  reserveDevPorts,
  runDevStartupAttempts,
  waitForDevListeners,
} from "./dev-ports.js";

const ports = {
  desktopCdp: 9311,
  desktopVite: 5178,
  server: 4705,
  operator: 4706,
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function listen(port: number): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

describe("devListenerPorts", () => {
  it("uses one allocator lock shared by every worktree under the OS temp root", () => {
    expect(devPortAllocatorLockPath({ tempPath: "/private/tmp" })).toBe(
      "/private/tmp/catamorphic-dev/port-allocation.lock",
    );
  });

  it("waits only for listeners owned by each focused target", () => {
    expect(devListenerPorts({ target: "desktop", ports })).toEqual([
      9311, 5178,
    ]);
    expect(devListenerPorts({ target: "server", ports })).toEqual([4705, 4706]);
    expect(devListenerPorts({ target: "all", ports })).toEqual([
      9311, 5178, 4705, 4706,
    ]);
  });

  it("confirms a focused server without waiting for desktop listeners", async () => {
    const first = await reserveDevPorts({
      reservePort: async () => {
        const server = createServer();
        const port = await new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("No numeric port"));
              return;
            }
            resolve(address.port);
          });
        });
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        return port;
      },
    });
    await listen(first.server);
    await listen(first.operator);

    await expect(
      waitForDevListeners({
        target: "server",
        ports: first,
        childExit: new Promise(() => undefined),
        timeoutMs: 250,
        stabilityMs: 10,
      }),
    ).resolves.toBeUndefined();
  });

  it("reports an early child exit as a retryable startup failure", async () => {
    await expect(
      waitForDevListeners({
        target: "all",
        ports,
        childExit: Promise.resolve({ code: 1, signal: null }),
        timeoutMs: 250,
        stabilityMs: 10,
      }),
    ).rejects.toBeInstanceOf(DevStartupAttemptError);
  });
});

describe("runDevStartupAttempts", () => {
  it("retries a collision with a completely new four-port plan", async () => {
    let nextPort = 41000;
    const attemptedPlans: number[][] = [];
    const releases: number[] = [];

    const result = await runDevStartupAttempts({
      maxAttempts: 3,
      allocate: async ({ excludedPorts }) => {
        const allocatedPorts = await reserveDevPorts({
          excludedPorts,
          reservePort: async () => nextPort++,
        });
        const allocationNumber = releases.length + 1;
        return {
          ports: allocatedPorts,
          bindProcessGroup: async () => undefined,
          release: async () => {
            releases.push(allocationNumber);
          },
        };
      },
      start: async ({ attempt, allocation }) => {
        expect(releases).toEqual(attempt === 1 ? [] : [1]);
        attemptedPlans.push(Object.values(allocation.ports));
        if (attempt === 1) {
          throw new DevStartupAttemptError("EADDRINUSE");
        }
        return "started";
      },
    });

    expect(result).toBe("started");
    expect(attemptedPlans).toEqual([
      [41000, 41001, 41002, 41003],
      [41004, 41005, 41006, 41007],
    ]);
    expect(releases).toEqual([1, 2]);
  });

  it("stops after the bounded startup-attempt count", async () => {
    let allocations = 0;
    let nextPort = 42000;

    await expect(
      runDevStartupAttempts({
        maxAttempts: 3,
        allocate: async ({ excludedPorts }) => {
          allocations += 1;
          return {
            ports: await reserveDevPorts({
              excludedPorts,
              reservePort: async () => nextPort++,
            }),
            bindProcessGroup: async () => undefined,
            release: async () => undefined,
          };
        },
        start: async () => {
          throw new DevStartupAttemptError("still colliding");
        },
      }),
    ).rejects.toThrow("still colliding");
    expect(allocations).toBe(3);
  });
});
