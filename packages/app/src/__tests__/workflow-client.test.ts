import { describe, expect, it, vi } from "vitest";
import { createWorkflowClient } from "../workflow-client.js";

describe("shared workflow client", () => {
  it("keeps call, start and restored handles on one transport", async () => {
    const call = vi.fn(async () => ({ count: 1 }));
    const start = vi.fn(async () => ({ runId: "run-1" }));
    const poll = vi.fn(async () => ({
      runId: "run-1",
      status: "completed",
      output: { count: 2 },
      error: null,
    }));
    const client = createWorkflowClient({ call, start, poll });
    expect(await client.call({ workflow: "count", input: {} })).toEqual({
      count: 1,
    });
    const handle = await client.start<{ count: number }>({
      workflow: "count",
      input: {},
    });
    expect(handle.runId).toBe("run-1");
    expect(await handle.result()).toEqual({ count: 2 });
    expect(await client.run({ runId: handle.runId }).poll()).toMatchObject({
      output: { count: 2 },
    });
    expect(poll).toHaveBeenCalledWith({ runId: "run-1", signal: undefined });
  });

  it("aborts waiting while preserving the host run", async () => {
    const controller = new AbortController();
    const client = createWorkflowClient({
      call: async () => null,
      start: async () => ({ runId: "durable" }),
      poll: async () => ({
        runId: "durable",
        status: "waiting",
        output: null,
        error: null,
      }),
    });
    const result = client
      .run({ runId: "durable" })
      .result({ signal: controller.signal, pollIntervalMs: 100 });
    controller.abort(new Error("Stop waiting"));
    await expect(result).rejects.toThrow("Stop waiting");
    expect((await client.run({ runId: "durable" }).poll()).status).toBe(
      "waiting",
    );
  });
});
