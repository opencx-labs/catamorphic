import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  type ClientRunnerTransport,
  ReceiptRefusedError,
  ResultRejectedError,
  RunnerSessionEndedError,
} from "@catamorphic/server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileConfigManager } from "./profile-config.js";
import { RemoteClientRunners } from "./remote-client-runner.js";

const started = vi.hoisted(
  () =>
    [] as Array<{
      onError?: (error: unknown) => void;
      transport: ClientRunnerTransport;
    }>,
);
vi.mock("@catamorphic/server-sdk", () => ({
  startClientRunner: (args: {
    onError?: (error: unknown) => void;
    transport: ClientRunnerTransport;
  }) => {
    started.push(args);
    return { stop: async () => {} };
  },
  ReceiptRefusedError: class extends Error {},
  ResultRejectedError: class extends Error {},
  RunnerSessionEndedError: class extends Error {},
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

  it("tells the runner which answers end its session and which to retry", async () => {
    const machine = runners({ current: true });
    await machine.connect({ projectId: "local", environment: "laptop" });
    const transport = started[0]?.transport;
    if (!transport) throw new Error("No runner started");
    const answer = (status: number) =>
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: `answered ${status}` }, { status }),
      );
    const poll = () =>
      transport.poll({
        pollId: "8f0c7c1e-2b1a-4e5d-9c3f-0a1b2c3d4e5f",
        signal: new AbortController().signal,
      });
    const receipt = () => transport.complete({ jobId: "job", response: null });

    answer(502);
    await expect(poll()).rejects.not.toBeInstanceOf(RunnerSessionEndedError);
    answer(409);
    await expect(poll()).rejects.toBeInstanceOf(RunnerSessionEndedError);
    answer(403);
    await expect(poll()).rejects.toBeInstanceOf(RunnerSessionEndedError);
    answer(503);
    await expect(receipt()).rejects.not.toBeInstanceOf(ReceiptRefusedError);
    answer(409);
    await expect(receipt()).rejects.toBeInstanceOf(ReceiptRefusedError);
    answer(413);
    await expect(receipt()).rejects.toBeInstanceOf(ResultRejectedError);
    await machine.stop();
  });
});
