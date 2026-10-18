import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
import { createAcpAdapter } from "../adapter.js";

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
