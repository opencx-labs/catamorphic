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
      sessions: Record<
        string,
        {
          cwd: string;
          mcpServers: Array<{ name: string }>;
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
    expect(space.state().sessions["session-1"]?.prompts[1]).toEqual([
      { type: "text", text: "[[recall]]" },
    ]);
  });

  it("fails the turn clearly when the session to reopen is gone", async () => {
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
    expect(turn.completed()).toMatchObject({ status: "failed" });
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
    turn.send({ kind: "interrupt" });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
    expect(turn.events()).toContainEqual(
      expect.objectContaining({ type: "item.completed", status: "completed" }),
    );
  });

  it("withdraws a waiting permission request when the turn is interrupted", async () => {
    const space = workspace();
    const turn = run(attempt(space, "[[permission]]"));
    await turn.until(() => turn.requests().length > 0);
    turn.send({ kind: "interrupt" });
    await turn.finished();
    expect(turn.completed()).toMatchObject({ status: "interrupted" });
  });

  // The person's own Hermes (`hermes acp`), its model and sign-in: an
  // external integration, run only with `bun run test:external`.
  const hermes =
    process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1"
      ? spawnSync("which", ["hermes"], { encoding: "utf8" }).stdout.trim()
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
