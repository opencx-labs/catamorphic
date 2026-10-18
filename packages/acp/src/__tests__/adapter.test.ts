import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASK_USER_TOOL,
  type AttemptStart,
  type HarnessEvent,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { agentQuestionJsonSchema } from "@catamorphic/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpAdapter, modelChoice } from "../adapter.js";
import { loopbackModelEnv, serveLoopbackModel } from "../model-endpoint.js";

/*
 * The ACP adapter end to end (ADR 0241): the real runner drives the real
 * adapter, which runs a real ACP agent process (the official SDK's agent
 * side) over stdio; host tools travel over a real loopback MCP server.
 */

const AGENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-agent.mjs",
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-adapter-"));
  dirs.push(dir);
  const stateFile = path.join(dir, "agent-state.json");
  return {
    dir,
    stateFile,
    state: (): {
      savedOnExit?: boolean;
      cancelled?: boolean;
      sleeper?: number;
      askedAfterCancel?: string;
      sessions: Record<
        string,
        {
          cwd: string;
          reopenedWith?: "load" | "resume";
          mcpServers: Array<{
            name: string;
            url?: string;
            headers?: Array<{ name: string; value: string }>;
          }>;
          prompts: Array<Array<{ type: string; text?: string }>>;
        }
      >;
    } => JSON.parse(fs.readFileSync(stateFile, "utf8")),
  };
}

function attempt(
  space: { dir: string; stateFile: string },
  text: string,
  overrides: Partial<AttemptStart> = {},
): AttemptStart {
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    sessionId: "session",
    projectId: "project",
    turnId: "turn",
    attemptId: "attempt",
    reason: "initial",
    harness: "acp",
    workingDirectory: space.dir,
    stateDirectory: space.dir,
    thread: { mode: "fresh", providerThreadId: "thread" },
    input: { itemId: "input", text, attachments: [] },
    systemPrompt: "",
    context: "",
    permissions: {},
    modelAccess: { kind: "host" },
    toolPolicies: {},
    toolAnnotations: {},
    mcpServers: {},
    hostTools: [],
    plugins: [],
    env: { TEST_AGENT_STATE: space.stateFile },
    options: { command: [process.execPath, AGENT] },
    ...overrides,
  };
}

/** One attempt on the real runner, and a reader of everything it said. */
function run(start: AttemptStart) {
  const runner = new InProcessRunner({
    adapters: { acp: createAcpAdapter() },
    version: "test",
  });
  const frames: RunnerFrame[] = [];
  let cursor = 0;
  let sent = 0;
  const send = (command: RunnerCommand) =>
    runner.send({ id: `command-${++sent}`, command });
  const until = async (predicate: () => boolean, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting on the runner: ${JSON.stringify(events())}`,
        );
      const read = await runner.read({ afterSeq: cursor, waitMs: 50 });
      frames.push(...read);
      cursor = read.at(-1)?.seq ?? cursor;
    }
  };
  const events = () =>
    frames.flatMap((frame): HarnessEvent[] =>
      frame.type === "event" ? [frame.event] : [],
    );
  const completed = () =>
    events().find(
      (event): event is Extract<HarnessEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed",
    );
  const text = (kind: "assistant_message" | "reasoning") => {
    const keys = new Set(
      events().flatMap((event) =>
        event.type === "item.started" && event.item.kind === kind
          ? [event.key]
          : [],
      ),
    );
    return events()
      .flatMap((event) =>
        event.type === "item.delta" && keys.has(event.key) ? [event.text] : [],
      )
      .join("");
  };
  const requests = () =>
    events().flatMap((event) =>
      event.type === "request.opened" ? [event] : [],
    );
  const calls = () =>
    frames.flatMap((frame) => (frame.type === "call" ? [frame] : []));
  send({ kind: "start", attempt: start });
  return {
    runner,
    send,
    until,
    events,
    completed,
    text,
    requests,
    calls,
    finished: () => until(() => completed() !== undefined),
  };
}

describe("ACP adapter", () => {
  it("runs a turn: a session in the workspace, thoughts and a streamed reply, Work's words apart from the person's", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        systemPrompt: "Be brief.",
        context: "It is Friday.",
      }),
    );
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "completed" });
    expect(turn.events()).toContainEqual({
      type: "thread",
      ref: { id: "session-1", strength: "strong" },
    });
    expect(turn.text("reasoning")).toBe("Thinking it over.");
    expect(turn.text("assistant_message")).toBe("Echo: hello");
    const session = space.state().sessions["session-1"];
    expect(session?.cwd).toBe(space.dir);
    expect(session?.prompts[0]).toEqual([
      {
        type: "text",
        text: "<work-instructions>\nBe brief.\n</work-instructions>",
      },
      { type: "text", text: "<work-context>\nIt is Friday.\n</work-context>" },
      { type: "text", text: "hello" },
    ]);
  });

  it("reopens the agent's session on a later turn, without its replayed history or the instructions again", async () => {
    const space = workspace();
    const first = run(attempt(space, "hello", { systemPrompt: "Be brief." }));
    await first.finished();
    const second = run(
      attempt(space, "[[recall]]", {
        systemPrompt: "Be brief.",
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-1", strength: "strong" },
        },
      }),
    );
    await second.finished();
    expect(second.completed()).toMatchObject({ status: "completed" });
    expect(second.text("assistant_message")).toBe("Turn 2");
    expect(JSON.stringify(second.events())).not.toContain("(replayed)");
    expect(space.state().sessions["session-1"]?.reopenedWith).toBe("load");
    expect(space.state().sessions["session-1"]?.prompts[1]).toEqual([
      { type: "text", text: "[[recall]]" },
    ]);
  });

  it("reopens with session/load even when the agent offers session/resume, its replay the proof the session is there", async () => {
    const space = workspace();
    const env = { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_RESUME: "1" };
    const first = run(attempt(space, "hello", { env }));
    await first.finished();
    const second = run(
      attempt(space, "[[recall]]", {
        env,
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-1", strength: "strong" },
        },
      }),
    );
    await second.finished();
    expect(second.text("assistant_message")).toBe("Turn 2");
    expect(space.state().sessions["session-1"]?.reopenedWith).toBe("load");
    expect(JSON.stringify(second.events())).not.toContain("(replayed)");
  });

  it("reopens with session/resume when the agent offers only that", async () => {
    const space = workspace();
    const env = {
      TEST_AGENT_STATE: space.stateFile,
      TEST_AGENT_RESUME: "1",
      TEST_AGENT_NO_LOAD: "1",
    };
    const first = run(attempt(space, "hello", { env }));
    await first.finished();
    const second = run(
      attempt(space, "[[recall]]", {
        env,
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-1", strength: "strong" },
        },
      }),
    );
    await second.finished();
    expect(second.completed()).toMatchObject({ status: "completed" });
    expect(second.text("assistant_message")).toBe("Turn 2");
    expect(space.state().sessions["session-1"]?.reopenedWith).toBe("resume");
  });

  it("ends the turn once the agent has exited, so a session it saves on exit is saved before a next turn reopens it", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: {
          TEST_AGENT_STATE: space.stateFile,
          TEST_AGENT_EXIT_SAVE_MS: "500",
        },
      }),
    );
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "completed" });
    expect(space.state().savedOnExit).toBe(true);
  });

  it("tells Work its session is gone when the agent refuses to reopen it, and fails before beginning the turn", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-9", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    // Work runs the turn again on a new thread it hands the conversation
    // (ADR 0245): this attempt neither starts the turn nor a session.
    expect(turn.events()).toContainEqual({
      type: "thread.lost",
      reason: expect.stringContaining(
        "test-agent couldn't reopen its earlier session (",
      ),
    });
    expect(turn.completed()).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("couldn't reopen") },
    });
    expect(
      turn
        .events()
        .some(
          (event) => event.type === "turn.started" || event.type === "thread",
        ),
    ).toBe(false);
    // The agent opened no session of its own.
    expect(
      fs.existsSync(space.stateFile) ? space.state().sessions : {},
    ).toEqual({});
  });

  it("serves host tools over MCP: the host runs the call and the agent reads its result", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, '[[tool workspace lookup {"q":"cats"}]]', {
        hostTools: [
          {
            name: "lookup",
            description: "Look something up.",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      }),
    );
    await turn.until(() => turn.calls().length > 0);
    const [call] = turn.calls();
    expect(call?.call).toEqual({
      kind: "tool",
      name: "lookup",
      input: { q: "cats" },
    });
    turn.send({
      kind: "host_result",
      callId: call?.callId ?? "",
      result: { content: [{ type: "text", text: "found 3 cats" }] },
    });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "completed" });
    expect(turn.text("assistant_message")).toBe("Tool said: found 3 cats");
    // A late word on the finished call never splits the reply around it.
    expect(
      turn
        .events()
        .filter(
          (event) =>
            event.type === "item.started" &&
            event.item.kind === "assistant_message",
        ),
    ).toHaveLength(1);
    expect(
      space
        .state()
        .sessions["session-1"]?.mcpServers.map((server) => server.name),
    ).toEqual(["workspace"]);
    expect(turn.events()).toContainEqual({
      type: "item.completed",
      key: "tool:call-1",
      status: "completed",
      item: { result: "found 3 cats" },
    });
    // The agent's later word on a finished call is not a second call.
    expect(
      turn
        .events()
        .filter(
          (event) =>
            (event.type === "item.started" ||
              event.type === "item.completed") &&
            event.key === "tool:call-1",
        )
        .map((event) => event.type),
    ).toEqual(["item.started", "item.completed"]);
  });

  it("checks the tool server's bearer before anything a request carries, so a malformed path is refused", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "[[hang]]", {
        hostTools: [
          {
            name: "lookup",
            description: "Look something up.",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    await turn.until(() => turn.text("assistant_message") === "Working");
    const server = space.state().sessions["session-1"]?.mcpServers[0];
    if (!server?.url) throw new Error("No tool server was given to the agent");
    const origin = new URL(server.url).origin;
    expect((await fetch(`${origin}/%`)).status).toBe(401);
    const authorization = server.headers?.[0]?.value ?? "";
    expect(
      (await fetch(`${origin}/%`, { headers: { authorization } })).status,
    ).toBe(404);
    turn.send({ kind: "interrupt" });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
  });

  it("refuses a host tool its policy denies, without calling the host", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, '[[tool workspace lookup {"q":"cats"}]]', {
        hostTools: [
          {
            name: "lookup",
            description: "Look something up.",
            inputSchema: { type: "object" },
          },
        ],
        toolPolicies: { workspace: [{ default: "deny" }] },
      }),
    );
    await turn.finished();
    expect(turn.calls()).toEqual([]);
    expect(turn.events()).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        key: "tool:call-1",
        status: "failed",
      }),
    );
  });

  it("asks the person through Work's ask_user tool and hands the agent their answer", async () => {
    const space = workspace();
    const questions = {
      questions: [
        {
          question: "Which color?",
          header: "Color",
          options: [{ label: "Blue", description: "The sky" }],
        },
      ],
    };
    const turn = run(
      attempt(
        space,
        `[[tool workspace ${ASK_USER_TOOL} ${JSON.stringify(questions)}]]`,
        {
          hostTools: [
            {
              name: ASK_USER_TOOL,
              description: "Ask the user.",
              inputSchema: JSON.parse(JSON.stringify(agentQuestionJsonSchema)),
            },
          ],
        },
      ),
    );
    await turn.until(() => turn.requests().length > 0);
    const [asked] = turn.requests();
    expect(asked?.request).toMatchObject({
      kind: "question",
      title: "Which color?",
    });
    turn.send({
      kind: "respond",
      requestKey: asked?.key ?? "",
      response: { kind: "question", answers: ["Blue"] },
    });
    await turn.finished();
    expect(turn.text("assistant_message")).toBe(
      "Tool said: Which color?\nAnswer: Blue",
    );
  });

  it.each([
    [{ kind: "approval", decision: "approved" }, "allow_once"],
    [
      { kind: "approval", decision: "approved", remember: "always" },
      "allow_session",
    ],
    [{ kind: "approval", decision: "denied" }, "deny"],
  ] as const)(
    "turns the agent's permission request into an approval: %j picks %s",
    async (response, option) => {
      const space = workspace();
      const turn = run(attempt(space, "[[permission]]"));
      await turn.until(() => turn.requests().length > 0);
      const [asked] = turn.requests();
      expect(asked?.request).toMatchObject({
        kind: "approval",
        blocking: true,
        title: "rm -rf build",
        origin: { kind: "provider", id: "test-agent" },
        approval: {
          details: "rm -rf build",
          tool: { name: "execute", input: { command: "rm -rf build" } },
        },
      });
      turn.send({ kind: "respond", requestKey: asked?.key ?? "", response });
      await turn.finished();
      expect(turn.text("assistant_message")).toBe(`Permission: ${option}`);
    },
  );

  it("interrupts a running turn through the agent's own cancel", async () => {
    const space = workspace();
    const turn = run(attempt(space, "[[hang]]"));
    await turn.until(() => turn.text("assistant_message") === "Working");
    const interruptedAt = Date.now();
    turn.send({ kind: "interrupt" });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
    expect(turn.events()).toContainEqual(
      expect.objectContaining({ type: "item.completed", status: "completed" }),
    );
    // The agent ended its turn on the cancel, long before it would be killed.
    expect(space.state().cancelled).toBe(true);
    expect(Date.now() - interruptedAt).toBeLessThan(5_000);
  });

  it("kills an interrupted agent that ignores the cancel and the stop alike", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "[[hang]]", {
        env: { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_STUBBORN: "1" },
      }),
    );
    await turn.until(() => turn.text("assistant_message") === "Working");
    turn.send({ kind: "interrupt" });
    await turn.until(() => turn.completed() !== undefined, 20_000);
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
    // What it started goes with it (gone, or a zombie its new parent has
    // yet to reap).
    const sleeper = space.state().sleeper ?? 0;
    expect(sleeper).toBeGreaterThan(0);
    const stat = () =>
      spawnSync("ps", ["-o", "stat=", "-p", String(sleeper)], {
        encoding: "utf8",
      }).stdout.trim();
    const deadline = Date.now() + 5_000;
    while (stat() && !stat().startsWith("Z") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stat() === "" || stat().startsWith("Z")).toBe(true);
  }, 30_000);

  it("cancels a permission request the agent makes after the interrupt, opening no approval", async () => {
    const space = workspace();
    const turn = run(attempt(space, "[[hang then ask]]"));
    await turn.until(() => turn.text("assistant_message") === "Working");
    const interruptedAt = Date.now();
    turn.send({ kind: "interrupt" });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
    expect(space.state().askedAfterCancel).toBe("cancelled");
    expect(turn.requests()).toEqual([]);
    expect(Date.now() - interruptedAt).toBeLessThan(5_000);
  });

  it("withdraws its own waiting permission request when the turn is interrupted", async () => {
    // The adapter alone, so nothing else closes the request for it.
    const space = workspace();
    const events: HarnessEvent[] = [];
    let asked: AbortSignal | undefined;
    const control = createAcpAdapter().start(attempt(space, "[[permission]]"), {
      emit: (event) => events.push(event),
      callTool: async () => ({ content: [] }),
      authorize: async () => ({ allowed: true }),
      request: (_key, _request, options) =>
        new Promise((_, reject) => {
          asked = options?.signal;
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("withdrawn")),
          );
        }),
      nativeState: {
        append: async () => {},
        load: async () => null,
        subpaths: async () => [],
      },
      signal: new AbortController().signal,
    });
    const deadline = Date.now() + 20_000;
    while (!asked && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    control.interrupt();
    await control.finished;
    expect(asked?.aborted).toBe(true);
    const said = events.flatMap((event) =>
      event.type === "item.delta" ? [event.text] : [],
    );
    expect(said).toContain("Permission: cancelled");
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      status: "interrupted",
    });
  });

  // The person's own Hermes (`hermes acp`), its model and sign-in: an
  // external integration, run only with `bun run test:external`.
  const hermes =
    process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1"
      ? spawnSync("which", ["hermes"], { encoding: "utf8" }).stdout.trim() ||
        [path.join(os.homedir(), ".local", "bin", "hermes")].find((file) =>
          fs.existsSync(file),
        ) ||
        ""
      : "";
  it.skipIf(!hermes)(
    "runs Hermes: a host tool over MCP, a streamed reply, and the session reopened on the next turn",
    async () => {
      const space = workspace();
      const hostTools = [
        {
          name: "lookup",
          description: "Look a word up in the project's glossary.",
          inputSchema: {
            type: "object",
            properties: { word: { type: "string" } },
            required: ["word"],
          },
        },
      ];
      const first = run(
        attempt(
          space,
          'Call the lookup tool with word "zorp", then reply with exactly what it returned and nothing else.',
          { hostTools, options: { command: [hermes, "acp"] } },
        ),
      );
      await first.until(() => first.calls().length > 0, 180_000);
      const [call] = first.calls();
      expect(call?.call).toMatchObject({
        kind: "tool",
        name: "lookup",
        input: { word: "zorp" },
      });
      first.send({
        kind: "host_result",
        callId: call?.callId ?? "",
        result: {
          content: [{ type: "text", text: "zorp: a small blue teapot" }],
        },
      });
      await first.until(() => first.completed() !== undefined, 180_000);
      expect(first.completed()).toMatchObject({ status: "completed" });
      expect(first.text("assistant_message")).toContain("blue teapot");
      const thread = first.events().find((event) => event.type === "thread");
      const nativeRef = thread?.type === "thread" ? thread.ref : undefined;
      expect(nativeRef?.id).toBeTruthy();

      const second = run(
        attempt(
          space,
          "What did zorp turn out to be? Answer in five words or fewer.",
          {
            hostTools,
            options: { command: [hermes, "acp"] },
            thread: {
              mode: "resume",
              providerThreadId: "thread",
              nativeRef: nativeRef ?? { id: "", strength: "strong" },
            },
          },
        ),
      );
      await second.until(() => second.completed() !== undefined, 180_000);
      expect(second.completed()).toMatchObject({ status: "completed" });
      expect(second.text("assistant_message").toLowerCase()).toContain(
        "teapot",
      );
    },
    400_000,
  );

  it("never makes a one-time denial permanent: offered no 'reject once', the request is cancelled", async () => {
    const space = workspace();
    const turn = run(attempt(space, "[[permission no-reject-once]]"));
    await turn.until(() => turn.requests().length > 0);
    const [asked] = turn.requests();
    turn.send({
      kind: "respond",
      requestKey: asked?.key ?? "",
      response: { kind: "approval", decision: "denied" },
    });
    await turn.finished();
    expect(turn.text("assistant_message")).toBe("Permission: cancelled");
  });

  it("reports a new session only once its first turn is done, so an interrupted one starts afresh", async () => {
    const space = workspace();
    const turn = run(attempt(space, "[[hang]]"));
    await turn.until(() => turn.text("assistant_message") === "Working");
    turn.send({ kind: "interrupt" });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
    expect(turn.events().some((event) => event.type === "thread")).toBe(false);
  });

  it("never reports a session the agent cannot reopen, so Work hands it the whole conversation each turn", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_NO_LOAD: "1" },
      }),
    );
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "completed" });
    expect(turn.events().some((event) => event.type === "thread")).toBe(false);
  });

  it("never widens a one-time approval: offered no 'once', the agent is told no", async () => {
    const space = workspace();
    const turn = run(attempt(space, "[[permission always-only]]"));
    await turn.until(() => turn.requests().length > 0);
    const [asked] = turn.requests();
    turn.send({
      kind: "respond",
      requestKey: asked?.key ?? "",
      response: { kind: "approval", decision: "approved" },
    });
    await turn.finished();
    expect(turn.text("assistant_message")).toBe("Permission: deny");
  });

  it("tells Work its session is gone when the agent no longer reopens sessions", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_NO_LOAD: "1" },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-1", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    expect(turn.events()).toContainEqual({
      type: "thread.lost",
      reason: "test-agent couldn't reopen its earlier session.",
    });
    expect(turn.completed()).toMatchObject({ status: "failed" });
    expect(turn.events().some((event) => event.type === "turn.started")).toBe(
      false,
    );
    expect(fs.existsSync(space.stateFile)).toBe(false);
  });

  it("tells Work its session is gone when the agent answers a load with nothing replayed, as Hermes does for a session it lost", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_LOAD: "hermes" },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-9", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    expect(turn.events()).toContainEqual({
      type: "thread.lost",
      reason:
        "test-agent couldn't reopen its earlier session (it replayed none of it).",
    });
    expect(turn.completed()).toMatchObject({ status: "failed" });
    expect(turn.events().some((event) => event.type === "turn.started")).toBe(
      false,
    );
  });

  it("tells Work its session is gone when the agent throws a plain error naming it invalid, as Gemini CLI does", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_LOAD: "plain" },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-9", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    expect(turn.events()).toContainEqual(
      expect.objectContaining({ type: "thread.lost" }),
    );
  });

  it("tells Work a session is gone when a load replays nothing and the agent no longer lists it", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: {
          TEST_AGENT_STATE: space.stateFile,
          TEST_AGENT_LOAD: "hermes",
          TEST_AGENT_LIST: "1",
        },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-9", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    expect(turn.events()).toContainEqual(
      expect.objectContaining({ type: "thread.lost" }),
    );
  });

  it("leaves a session the agent still lists for the next turn when its load replays nothing, as Hermes does when a restore fails", async () => {
    const space = workspace();
    const first = run(attempt(space, "hello"));
    await first.finished();
    const second = run(
      attempt(space, "again", {
        env: {
          TEST_AGENT_STATE: space.stateFile,
          TEST_AGENT_LOAD: "hermes-flaky",
          TEST_AGENT_LIST: "1",
        },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-1", strength: "strong" },
        },
      }),
    );
    await second.finished();
    expect(second.completed()).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("though it still has it") },
    });
    expect(second.events().some((event) => event.type === "thread.lost")).toBe(
      false,
    );
  });

  it("tells Work its session is gone when the agent answers a load with an internal error and no longer lists it, as OpenCode does", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: {
          TEST_AGENT_STATE: space.stateFile,
          TEST_AGENT_LOAD: "opencode",
          TEST_AGENT_LIST: "1",
        },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-9", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    expect(turn.events()).toContainEqual(
      expect.objectContaining({
        type: "thread.lost",
        reason: expect.stringContaining("OpenCode service failure"),
      }),
    );
  });

  it("leaves a session the agent still lists for the next turn when its load fails with an internal error", async () => {
    const space = workspace();
    const first = run(attempt(space, "hello"));
    await first.finished();
    const second = run(
      attempt(space, "again", {
        env: {
          TEST_AGENT_STATE: space.stateFile,
          TEST_AGENT_LOAD: "busy",
          TEST_AGENT_LIST: "1",
        },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-1", strength: "strong" },
        },
      }),
    );
    await second.finished();
    expect(second.completed()).toMatchObject({ status: "failed" });
    expect(second.events().some((event) => event.type === "thread.lost")).toBe(
      false,
    );
  });

  it("tells Work its session is gone when the agent refuses to resume it", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        env: {
          TEST_AGENT_STATE: space.stateFile,
          TEST_AGENT_RESUME: "1",
          TEST_AGENT_NO_LOAD: "1",
        },
        thread: {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "session-9", strength: "strong" },
        },
      }),
    );
    await turn.finished();
    expect(turn.events()).toContainEqual(
      expect.objectContaining({ type: "thread.lost" }),
    );
    expect(turn.completed()).toMatchObject({ status: "failed" });
  });

  it.each([
    ["a sign-in", "auth"],
    ["a passing error", "busy"],
    ["a crash", "crash"],
  ])(
    "leaves the session for the next turn when reopening fails for %s",
    async (_why, failing) => {
      const space = workspace();
      const turn = run(
        attempt(space, "hello", {
          env: { TEST_AGENT_STATE: space.stateFile, TEST_AGENT_LOAD: failing },
          thread: {
            mode: "resume",
            providerThreadId: "thread",
            nativeRef: { id: "session-1", strength: "strong" },
          },
        }),
      );
      await turn.finished();
      expect(turn.completed()).toMatchObject({ status: "failed" });
      expect(turn.events().some((event) => event.type === "thread.lost")).toBe(
        false,
      );
    },
  );

  it("fails the turn clearly when the agent's command cannot start", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        options: { command: ["/nonexistent/hermes", "acp"] },
      }),
    );
    await turn.finished();
    expect(turn.completed()).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("Couldn't start hermes") },
    });
  });
});

/**
 * A stand-in for the gateway's model route: a Chat Completions API that
 * answers only the grant now in `keyFile`, echoing the model it was asked
 * for. `rotate` renews the grant as the gateway does, the old one refused
 * at once; `renewDuringNextCall` renews it while the next call is on its
 * way, so that call arrives with the grant just revoked.
 */
async function fakeGateway(keyFile: string) {
  const seen: Array<{ authorization: string; body: string }> = [];
  let grant = "grant-1";
  let renewal: string | undefined;
  fs.writeFileSync(keyFile, `${grant}\n`);
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const authorization = String(request.headers.authorization ?? "");
      seen.push({ authorization, body });
      if (renewal) {
        grant = renewal;
        renewal = undefined;
        fs.writeFileSync(keyFile, `${grant}\n`);
      }
      if (
        authorization !== `Bearer ${grant}` ||
        request.url !== "/gateway/model/models/chat/completions"
      ) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "bad grant" } }));
        return;
      }
      const model = String(JSON.parse(body).model);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: `hi from ${model}` } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/gateway/model/models`,
    rotate: (next: string) => {
      grant = next;
      fs.writeFileSync(keyFile, `${next}\n`);
    },
    renewDuringNextCall: (next: string) => {
      renewal = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("ACP agents on a model connection (ADR 0255)", () => {
  const gatewayAttempt = (
    space: ReturnType<typeof workspace>,
    gateway: { baseUrl: string },
    env: Record<string, string> = {},
  ) =>
    attempt(space, "[[model]]", {
      model: "deepseek/v4-flash",
      modelAccess: {
        kind: "gateway",
        api: "openai",
        baseUrl: gateway.baseUrl,
        keyFile: path.join(space.dir, "grant"),
      },
      env: { TEST_AGENT_STATE: space.stateFile, ...env },
    });

  it("reaches its model through the gateway on loopback, never holding the grant", async () => {
    const space = workspace();
    const gateway = await fakeGateway(path.join(space.dir, "grant"));
    try {
      const turn = run(gatewayAttempt(space, gateway));
      await turn.finished();
      expect(turn.completed()).toMatchObject({ status: "completed" });
      expect(turn.text("assistant_message")).toBe(
        "Model said (200): hi from deepseek/v4-flash",
      );
      // The agent sent its own key; the gateway saw the grant.
      expect(gateway.seen.map((call) => call.authorization)).toEqual([
        "Bearer grant-1",
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("chooses the definition's model where the agent offers models, and points its providers at the gateway", async () => {
    const space = workspace();
    const gateway = await fakeGateway(path.join(space.dir, "grant"));
    try {
      const turn = run(
        gatewayAttempt(space, gateway, {
          TEST_AGENT_MODELS: "1",
          TEST_AGENT_PROVIDERS: "1",
        }),
      );
      await turn.finished();
      expect(turn.text("assistant_message")).toBe(
        "Model said (200): hi from deepseek/v4-flash",
      );
      const state = space.state() as ReturnType<typeof space.state> & {
        providers?: Record<
          string,
          { apiType: string; baseUrl: string; headers: Record<string, string> }
        >;
      };
      expect(state.sessions["session-1"]).toMatchObject({
        model: "deepseek/v4-flash",
      });
      // Only the provider that speaks the connection's API, at loopback;
      // the optional one that speaks another is turned off.
      expect(Object.keys(state.providers ?? {})).toEqual(["main"]);
      expect((state as { disabled?: string[] }).disabled).toEqual(["cloud"]);
      expect(state.providers?.main).toMatchObject({ apiType: "openai" });
      expect(state.providers?.main?.baseUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+$/,
      );
      expect(state.providers?.main?.headers.authorization).toMatch(
        /^Bearer work-/,
      );
      expect(JSON.stringify(state)).not.toContain("grant-1");
    } finally {
      await gateway.close();
    }
  });

  it("goes on with the variables when the agent fails to take providers, and says so", async () => {
    const space = workspace();
    const gateway = await fakeGateway(path.join(space.dir, "grant"));
    try {
      const turn = run(
        gatewayAttempt(space, gateway, { TEST_AGENT_PROVIDERS: "fail" }),
      );
      await turn.finished();
      expect(turn.text("assistant_message")).toBe(
        "Model said (200): hi from deepseek/v4-flash",
      );
      expect(turn.events()).toContainEqual(
        expect.objectContaining({
          type: "diagnostic",
          level: "warn",
          message: expect.stringContaining("WORK_MODEL_BASE_URL"),
        }),
      );
    } finally {
      await gateway.close();
    }
  });

  it("closes its model endpoint with the turn", async () => {
    const space = workspace();
    const gateway = await fakeGateway(path.join(space.dir, "grant"));
    try {
      const turn = run({
        ...gatewayAttempt(space, gateway),
        input: { itemId: "input", text: "[[where]]", attachments: [] },
      });
      await turn.finished();
      const where = turn.text("assistant_message");
      expect(where).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Anything the agent left running loses its model with the turn.
      await expect(fetch(`${where}/models`)).rejects.toThrow();
    } finally {
      await gateway.close();
    }
  });

  it("refuses a Work sign-in: an ACP agent brings its own or uses a connection", async () => {
    const space = workspace();
    const turn = run(
      attempt(space, "hello", {
        modelAccess: { kind: "sign_in", home: space.dir },
      }),
    );
    await turn.finished();
    expect(turn.completed()).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("not a Work sign-in") },
    });
  });
});

describe("choosing the definition's model", () => {
  const option = (currentValue: string, options: unknown) =>
    ({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options,
    }) as Parameters<typeof modelChoice>[0]["options"] extends
      | readonly (infer O)[]
      | null
      | undefined
      ? O
      : never;

  it("finds it by id, by name, or as the one value ending in it, in groups too", () => {
    const grouped = option("work/default", [
      {
        group: "work",
        name: "Work",
        options: [
          { value: "work/default", name: "Default" },
          { value: "work/deepseek/v4-flash", name: "DeepSeek" },
        ],
      },
    ]);
    expect(
      modelChoice({ options: [grouped], model: "deepseek/v4-flash" }),
    ).toEqual({
      kind: "set",
      configId: "model",
      value: "work/deepseek/v4-flash",
    });
    expect(modelChoice({ options: [grouped], model: "DeepSeek" })).toEqual({
      kind: "set",
      configId: "model",
      value: "work/deepseek/v4-flash",
    });
    expect(modelChoice({ options: [grouped], model: "work/default" })).toEqual({
      kind: "chosen",
    });
  });

  it("says what the agent offers when it offers no such model, and nothing when it offers no models", () => {
    const flat = option("a", [
      { value: "a", name: "A" },
      { value: "b", name: "B" },
    ]);
    expect(modelChoice({ options: [flat], model: "c" })).toEqual({
      kind: "unknown",
      offered: ["a", "b"],
    });
    expect(modelChoice({ options: [], model: "c" })).toBeUndefined();
    expect(modelChoice({ options: undefined, model: "c" })).toBeUndefined();
  });
});

/** A one-off upstream for the endpoint, and what it saw of each request. */
async function upstreamServer(
  handle: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
) {
  const closedEarly: string[] = [];
  const server = http.createServer((request, response) => {
    request.on("close", () => {
      if (!response.writableEnded) closedEarly.push(request.url ?? "");
    });
    handle(request, response);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    closedEarly,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("the loopback model endpoint", () => {
  const keyFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-model-"));
    dirs.push(dir);
    const file = path.join(dir, "grant");
    fs.writeFileSync(file, "grant-a\n");
    return file;
  };
  const until = async (check: () => boolean) => {
    for (let tries = 0; tries < 200 && !check(); tries++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  it("speaks the Anthropic API to an Anthropic connection: x-api-key both ways, its own error shape", async () => {
    const seen: Array<{ url: string; key: string }> = [];
    const upstream = await upstreamServer((request, response) => {
      seen.push({
        url: request.url ?? "",
        key: String(request.headers["x-api-key"]),
      });
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"type":"message"}');
      });
    });
    const model = await serveLoopbackModel({
      access: {
        kind: "gateway",
        api: "anthropic",
        baseUrl: `${upstream.baseUrl}/gateway/model/anthropic`,
        keyFile: keyFile(),
      },
    });
    try {
      expect(loopbackModelEnv({ model })).toMatchObject({
        WORK_MODEL_API: "anthropic",
        ANTHROPIC_BASE_URL: model.baseUrl,
        ANTHROPIC_API_KEY: model.apiKey,
      });
      const ok = await fetch(`${model.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": model.apiKey },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      expect(seen).toEqual([
        { url: "/gateway/model/anthropic/v1/messages", key: "grant-a" },
      ]);
      const refused = await fetch(`${model.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "someone-else" },
        body: "{}",
      });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({
        type: "error",
        error: { type: "authentication_error" },
      });
    } finally {
      model.close();
      await upstream.close();
    }
  });

  it("streams an answer as it arrives", async () => {
    let release = () => {};
    const upstream = await upstreamServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: one\n\n");
      release = () => response.end("data: two\n\n");
    });
    const model = await serveLoopbackModel({
      access: {
        kind: "gateway",
        api: "openai",
        baseUrl: upstream.baseUrl,
        keyFile: keyFile(),
      },
    });
    try {
      const answer = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${model.apiKey}` },
        body: "{}",
      });
      const reader = answer.body?.getReader();
      const first = await reader?.read();
      // The first event is here while the upstream has not finished.
      expect(new TextDecoder().decode(first?.value)).toContain("one");
      release();
      let rest = "";
      for (;;) {
        const next = await reader?.read();
        if (!next || next.done) break;
        rest += new TextDecoder().decode(next.value);
      }
      expect(rest).toContain("two");
    } finally {
      model.close();
      await upstream.close();
    }
  });

  it("stops the upstream call when the agent stops waiting, even before the answer's headers", async () => {
    const upstream = await upstreamServer((request) => {
      request.resume();
      // Never answers: a model thinking before its first byte.
    });
    const model = await serveLoopbackModel({
      access: {
        kind: "gateway",
        api: "openai",
        baseUrl: upstream.baseUrl,
        keyFile: keyFile(),
      },
    });
    try {
      const abort = new AbortController();
      const answer = fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${model.apiKey}` },
        body: "{}",
        signal: abort.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      abort.abort();
      await expect(answer).rejects.toThrow();
      await until(() => upstream.closedEarly.length === 1);
    } finally {
      model.close();
      await upstream.close();
    }
  });

  it("ends every call still running when it closes", async () => {
    const upstream = await upstreamServer((request) => {
      request.resume();
    });
    const model = await serveLoopbackModel({
      access: {
        kind: "gateway",
        api: "openai",
        baseUrl: upstream.baseUrl,
        keyFile: keyFile(),
      },
    });
    try {
      const answer = fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${model.apiKey}` },
        body: "{}",
      }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      model.close();
      await answer;
      await until(() => upstream.closedEarly.length === 1);
    } finally {
      await upstream.close();
    }
  });

  it("opens only to its own key, reads the grant per request, and retries once after a renewal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-model-"));
    dirs.push(dir);
    const keyFile = path.join(dir, "grant");
    const gateway = await fakeGateway(keyFile);
    const model = await serveLoopbackModel({
      access: {
        kind: "gateway",
        api: "openai",
        baseUrl: gateway.baseUrl,
        keyFile,
      },
    });
    const ask = (key: string) =>
      fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
    try {
      const stranger = await ask("not-the-key");
      expect(stranger.status).toBe(401);
      expect(gateway.seen).toHaveLength(0);

      expect((await ask(model.apiKey)).status).toBe(200);
      // Renewed between two calls: the next reads the new grant.
      gateway.rotate("grant-2");
      expect((await ask(model.apiKey)).status).toBe(200);
      expect(gateway.seen.map((call) => call.authorization)).toEqual([
        "Bearer grant-1",
        "Bearer grant-2",
      ]);

      // Renewed while a call was on its way: refused once, then sent again
      // with the grant the file holds now.
      gateway.renewDuringNextCall("grant-3");
      const retried = await ask(model.apiKey);
      expect(retried.status).toBe(200);
      expect(gateway.seen.slice(2).map((call) => call.authorization)).toEqual([
        "Bearer grant-2",
        "Bearer grant-3",
      ]);
      // A refusal the grant file cannot fix comes back as the gateway said.
      fs.writeFileSync(keyFile, "grant-revoked\n");
      const refused = await ask(model.apiKey);
      expect(refused.status).toBe(401);
      expect(gateway.seen).toHaveLength(5);
    } finally {
      model.close();
      await gateway.close();
    }
  });
});
