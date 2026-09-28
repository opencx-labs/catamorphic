import type { SandboxProvider } from "@catamorphic/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileConfigManager } from "./profile-config.js";
import { RemoteClientRunners } from "./remote-client-runner.js";

const started = vi.hoisted(
  () => [] as Array<{ onError?: (error: unknown) => void }>,
);
vi.mock("@catamorphic/server-sdk", () => ({
  startClientRunner: (args: { onError?: (error: unknown) => void }) => {
    started.push(args);
    return { stop: async () => {} };
  },
}));

const link = {
  connectionId: "7d1c3f0e-4c1b-4a4e-9a51-2f6c9c1b0a11",
  serverUrl: "https://work.example.test/api",
  remoteProjectId: "remote-project",
};

function runners(linked: { current: boolean }) {
  const profiles = {
    forProject: () => ({
      remoteProjects: {
        inspect: () => (linked.current ? { link } : null),
        accessToken: async () => "token",
      },
    }),
  } as unknown as ProfileConfigManager;
  const provider = {
    workspaceRoot: "/workspace",
    processes: {},
  } as unknown as SandboxProvider;
  return new RemoteClientRunners(profiles, provider);
}

describe("RemoteClientRunners", () => {
  const registrations: string[] = [];
  let refuse = false;
  beforeEach(() => {
    refuse = false;
    vi.useFakeTimers();
    started.length = 0;
    registrations.length = 0;
    vi.stubGlobal("fetch", async (request: Request) => {
      registrations.push(new URL(request.url).pathname);
      if (refuse)
        return Response.json({ error: "Not a member" }, { status: 403 });
      return Response.json({
        id: "5b3a0d8e-1f2c-4d3b-8e4f-6a7b8c9d0e1f",
        token: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects this machine after the connection drops, until stopped", async () => {
    const linked = { current: true };
    const machine = runners(linked);
    await machine.connect({ projectId: "local", environment: "laptop" });
    expect(registrations).toEqual([
      "/api/projects/remote-project/client-runners",
    ]);

    started[0]?.onError?.(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registrations).toHaveLength(2);
    expect(started).toHaveLength(2);

    await machine.stop();
    started[1]?.onError?.(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registrations).toHaveLength(2);
  });

  it("stops trying once the project is no longer linked", async () => {
    const linked = { current: true };
    const machine = runners(linked);
    await machine.connect({ projectId: "local", environment: "laptop" });
    linked.current = false;
    started[0]?.onError?.(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registrations).toHaveLength(1);
  });

  it("serves again after the computer wakes", async () => {
    const machine = runners({ current: true });
    await machine.connect({ projectId: "local", environment: "laptop" });
    await machine.stop();
    started[0]?.onError?.(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registrations).toHaveLength(1);
    machine.resume();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registrations).toHaveLength(2);
  });

  it("ignores a runner's second failure once a newer runner took over", async () => {
    const machine = runners({ current: true });
    await machine.connect({ projectId: "local", environment: "laptop" });
    started[0]?.onError?.(new Error("renew failed"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(started).toHaveLength(2);
    started[0]?.onError?.(new Error("poll failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    // The newer runner stays tracked: no further registration.
    expect(registrations).toHaveLength(2);
  });

  it("stops retrying when the server refuses this machine", async () => {
    const machine = runners({ current: true });
    await machine.connect({ projectId: "local", environment: "laptop" });
    refuse = true;
    started[0]?.onError?.(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registrations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(registrations).toHaveLength(2);
  });
});
