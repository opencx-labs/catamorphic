import { expect, it } from "vitest";
import {
  type AttemptStart,
  type HarnessAdapter,
  NO_CAPABILITIES,
  RUNNER_PROTOCOL_VERSION,
} from "../../packages/agent-protocol/src/runner.js";
import { runAttempt } from "./attempt.js";

const attempt: AttemptStart = {
  protocol: RUNNER_PROTOCOL_VERSION,
  sessionId: "session",
  projectId: "project",
  turnId: "turn",
  attemptId: "attempt",
  reason: "initial",
  harness: "eval-fake",
  workingDirectory: "/tmp",
  stateDirectory: "/tmp",
  thread: { mode: "fresh", providerThreadId: "thread" },
  input: { itemId: "input", text: "Build", attachments: [] },
  systemPrompt: "",
  context: "",
  permissions: {},
  modelAccess: { kind: "host" },
  toolPolicies: {},
  toolAnnotations: {},
  mcpServers: {},
  hostTools: [],
  plugins: [],
  env: {},
  options: {},
};

it("keeps real runner frames, services native state and waits for clean exit", async () => {
  const adapter: HarnessAdapter = {
    id: "eval-fake",
    capabilities: () => NO_CAPABILITIES,
    start: (_attempt, host) => ({
      steer: async () => false,
      interrupt: () => {},
      finished: (async () => {
        await host.nativeState.append({
          entries: [{ useful: true }],
        });
        expect(await host.nativeState.load({})).toEqual([{ useful: true }]);
        host.emit({ type: "turn.completed", status: "completed" });
      })(),
    }),
  };
  const types: string[] = [];
  const result = await runAttempt({
    adapter,
    attempt,
    timeoutMs: 1_000,
    frame: (frame) => types.push(frame.type),
  });
  expect(result.status).toBe("completed");
  expect(result.errors).toEqual([]);
  expect(types).toContain("call");
  expect(types.at(-1)).toBe("exit");
});

it("times out, interrupts the actual adapter, joins it and disposes it", async () => {
  const lifecycle: string[] = [];
  const adapter: HarnessAdapter = {
    id: "eval-fake",
    capabilities: () => NO_CAPABILITIES,
    start: (_attempt, host) => {
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        steer: async () => false,
        interrupt: () => {
          lifecycle.push("interrupt");
          host.emit({ type: "turn.completed", status: "interrupted" });
          finish();
        },
        finished,
      };
    },
    dispose: async () => {
      lifecycle.push("dispose");
    },
  };
  const result = await runAttempt({
    adapter,
    attempt,
    timeoutMs: 20,
    frame: () => {},
  });
  expect(result.status).toBe("timeout");
  expect(result.errors).toEqual(["Agent exceeded 20ms"]);
  expect(lifecycle).toEqual(["interrupt", "dispose"]);
});
