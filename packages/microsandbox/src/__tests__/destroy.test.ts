import { afterEach, expect, it, vi } from "vitest";

const calls: string[] = [];

// A running VM with volumes whose agent never answers a connection.
vi.mock("microsandbox", () => ({
  Sandbox: {
    get: async (name: string) => ({
      name,
      status: "running",
      config: () => ({
        labels: { "work.volumes": "cache-0123456789abcdef01234567" },
      }),
      connect: () => new Promise(() => {}),
      kill: async () => {
        calls.push("kill");
      },
      remove: async () => {
        calls.push("remove");
      },
    }),
  },
  Image: {},
  Volume: {},
}));

afterEach(() => {
  vi.useRealTimers();
  calls.length = 0;
});

it("destroys a sandbox whose VM does not answer, after the flush gives up", async () => {
  vi.useFakeTimers();
  const { MicrosandboxSandboxProvider } = await import(
    "../sandbox-provider.js"
  );
  const provider = new MicrosandboxSandboxProvider({ setupCommand: "" });
  const destroyed = provider.destroySandbox("unresponsive");
  await vi.advanceTimersByTimeAsync(61_000);
  await destroyed;
  expect(calls).toEqual(["kill", "remove"]);
});
