import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  HarnessEvent,
  McpServerSpec,
  ThreadBinding,
} from "@catamorphic/agent-protocol/runner";
import type { AttemptOutcome, ScriptedHostBehavior } from "./host.js";
import { pinnedClaudeExecutable } from "./pinned-cli.js";
import type { ScriptedReply, ScriptedRequest } from "./scripted-model.js";

/**
 * The replay scenarios: each says what the person and host do, how the
 * scripted model answers when it is recorded against the real CLI, and
 * what the adapter must report. Recording, replay tests and the live test
 * share these definitions.
 */
export interface ClaudeScenario {
  name: string;
  description: string;
  /** Files the working directory starts with. */
  files?: Record<string, string>;
  /** The scripted model, across all of the scenario's requests. */
  model: (request: ScriptedRequest, context: { cwd: string }) => ScriptedReply;
  attempts: ScenarioAttempt[];
  /** What the adapter must have reported, recorded or replayed alike. */
  check: (outcomes: AttemptOutcome[]) => void;
}

export interface ScenarioAttempt {
  /** Run in a new working directory and harness home (another machine). */
  elsewhere?: boolean;
  start: (context: ScenarioContext) => AttemptStart;
  host?: ScriptedHostBehavior;
}

/** Where an attempt runs, and what the scenario's earlier attempts reported. */
export interface ScenarioContext {
  cwd: string;
  state: string;
  home: string;
  modelUrl: string;
  /** The stdio MCP server tool-policy scenarios connect. */
  fixtureServer: McpServerSpec;
  previous: AttemptOutcome[];
}

/** A stable UUID from a seed: provider thread ids must be UUIDs. */
export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const SCENARIO_MODEL = "claude-sonnet-4-5";

/** An attempt as a host would start it: gateway model access, no host credentials. */
export function scenarioAttempt(input: {
  context: ScenarioContext;
  scenario: string;
  turn: number;
  text: string;
  thread?: ThreadBinding;
  overrides?: Partial<AttemptStart>;
}): AttemptStart {
  const { context } = input;
  const thread: ThreadBinding = input.thread ?? {
    mode: "fresh",
    providerThreadId: stableUuid(`${input.scenario}:thread`),
  };
  const start: AttemptStart = {
    protocol: 1,
    sessionId: `session-${input.scenario}`,
    projectId: "project-fixture",
    turnId: `turn-${input.scenario}-${input.turn}`,
    attemptId: `attempt-${input.scenario}-${input.turn}`,
    reason: "initial",
    harness: "claude-code",
    workingDirectory: context.cwd,
    stateDirectory: context.state,
    thread,
    input: {
      itemId: `item-${input.scenario}-${input.turn}`,
      text: input.text,
      attachments: [],
    },
    systemPrompt: "You are a Work fixture agent. Keep answers short.",
    context: "",
    model: SCENARIO_MODEL,
    permissions: { permissionMode: "acceptEdits" },
    modelAccess: {
      kind: "gateway",
      api: "anthropic",
      baseUrl: context.modelUrl,
      keyFile: path.join(context.state, "model-key"),
    },
    toolPolicies: {},
    toolAnnotations: {},
    mcpServers: {},
    hostTools: [],
    plugins: [],
    env: {
      CLAUDE_CONFIG_DIR: context.home,
      // Nothing but the scripted model is reachable.
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
    options: { memory: false },
    ...input.overrides,
  };
  // The pinned SDK's own CLI, never the PATH's: fixtures name its version.
  const command = pinnedClaudeExecutable();
  return command ? { ...start, options: { ...start.options, command } } : start;
}

// ---------------------------------------------------------------------------
// Reading what the scripted model was sent

function messagesOf(request: ScriptedRequest): JsonValue[] {
  const messages = request.body.messages;
  return Array.isArray(messages) ? messages : [];
}

/** Everything the model was sent, as one string to search. */
function sent(request: ScriptedRequest): string {
  return JSON.stringify(messagesOf(request));
}

/** The text of the last user message, tool results included. */
function lastUser(request: ScriptedRequest): string {
  const last = messagesOf(request).at(-1);
  return JSON.stringify(last ?? null);
}

/** The first user message: whose conversation this request belongs to. */
function firstUser(request: ScriptedRequest): string {
  return JSON.stringify(messagesOf(request)[0] ?? null);
}

function toolNames(request: ScriptedRequest): string[] {
  const tools = request.body.tools;
  return Array.isArray(tools)
    ? tools.flatMap((tool) =>
        tool &&
        typeof tool === "object" &&
        !Array.isArray(tool) &&
        typeof tool.name === "string"
          ? [tool.name]
          : [],
      )
    : [];
}

function toolSchema(request: ScriptedRequest, name: string): JsonValue {
  const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
  const tool = tools.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      entry.name === name,
  );
  return tool && typeof tool === "object" && !Array.isArray(tool)
    ? (tool.input_schema ?? null)
    : null;
}

function text(value: string): ScriptedReply {
  return { blocks: [{ type: "text", text: value }] };
}

function unexpected(request: ScriptedRequest): ScriptedReply {
  return {
    error: {
      status: 400,
      type: "invalid_request_error",
      message: `The scripted model did not expect request ${request.index}: ${lastUser(request).slice(0, 300)}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading what the adapter reported

type EventOf<T extends HarnessEvent["type"]> = Extract<
  HarnessEvent,
  { type: T }
>;

export function eventsOf<T extends HarnessEvent["type"]>(
  outcome: AttemptOutcome | undefined,
  type: T,
): EventOf<T>[] {
  return (outcome?.events ?? []).flatMap((event) =>
    event.type === type ? [event as EventOf<T>] : [],
  );
}

/** Every item the attempt reported, folded to its final fields and status. */
export function itemsOf(outcome: AttemptOutcome | undefined): Array<{
  key: string;
  status: string;
  parentKey?: string;
  item: JsonObject;
  deltas: number;
}> {
  const items = new Map<
    string,
    {
      key: string;
      status: string;
      parentKey?: string;
      item: JsonObject;
      deltas: number;
    }
  >();
  for (const event of outcome?.events ?? []) {
    if (event.type === "item.started") {
      const { parentKey, ...item } = event.item;
      items.set(event.key, {
        key: event.key,
        status: event.status ?? "in_progress",
        ...(parentKey ? { parentKey } : {}),
        item: toJsonObject(item),
        deltas: 0,
      });
      continue;
    }
    const current =
      event.type === "item.delta" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
        ? items.get(event.key)
        : undefined;
    if (!current) continue;
    if (event.type === "item.delta") {
      current.deltas += 1;
      const before = current.item[event.field];
      current.item[event.field] =
        `${typeof before === "string" ? before : ""}${event.text}`;
    } else if (event.type === "item.updated") {
      Object.assign(current.item, toJsonObject(event.item));
    } else if (event.type === "item.completed") {
      current.status = event.status;
      if (event.item) Object.assign(current.item, toJsonObject(event.item));
    }
  }
  return [...items.values()];
}

function toJsonObject(value: unknown): JsonObject {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? {}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function itemsOfKind(outcome: AttemptOutcome | undefined, kind: string) {
  return itemsOf(outcome).filter((entry) => entry.item.kind === kind);
}

/** The checks every settled attempt passes. */
function settled(
  outcome: AttemptOutcome | undefined,
  status: "completed" | "failed" | "interrupted",
): void {
  assert.ok(outcome, "the attempt ran");
  const completions = eventsOf(outcome, "turn.completed");
  assert.equal(completions.length, 1, "exactly one turn.completed");
  assert.equal(completions[0]?.status, status, JSON.stringify(completions[0]));
  assert.equal(outcome.frames.at(-1)?.type, "exit", "the runner exited");
  assert.ok(outcome.thread, "the native thread was reported");
  for (const item of itemsOf(outcome))
    assert.notEqual(
      item.status,
      "in_progress",
      `item ${item.key} was left open`,
    );
}

function reply(outcome: AttemptOutcome | undefined): string {
  return itemsOfKind(outcome, "assistant_message")
    .map((entry) => String(entry.item.text))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Scenarios

const simpleReply: ClaudeScenario = {
  name: "simple-reply",
  description: "One streamed answer with reasoning, turn context and usage.",
  model: (request) => {
    if (!sent(request).includes("fixture project is open"))
      return unexpected(request);
    return {
      blocks: [
        { type: "thinking", thinking: "**Greeting the person**\nSay hello." },
        { type: "text", text: "Hello from the fixture." },
      ],
    };
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "simple-reply",
          turn: 1,
          text: "Say hello",
          overrides: {
            context:
              "<turn_context>The fixture project is open.</turn_context>",
          },
        }),
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "completed");
    assert.deepEqual(outcome?.thread, {
      id: outcome?.attempt.thread.providerThreadId,
      strength: "strong",
    });
    const [message] = itemsOfKind(outcome, "assistant_message");
    assert.equal(message?.item.text, "Hello from the fixture.");
    assert.equal(message?.status, "completed");
    assert.ok((message?.deltas ?? 0) >= 2, "the answer streamed");
    const [reasoning] = itemsOfKind(outcome, "reasoning");
    assert.match(String(reasoning?.item.text), /Greeting the person/);
    assert.ok(
      eventsOf(outcome, "status").some(
        (event) => event.text === "Greeting the person",
      ),
      "the reasoning heading became the live line",
    );
    const [usage] = eventsOf(outcome, "usage");
    assert.equal(usage?.usage.model, SCENARIO_MODEL);
    assert.ok((usage?.usage.outputTokens ?? 0) > 0);
    const completed = eventsOf(outcome, "turn.completed")[0];
    assert.equal(completed?.ref?.strength, "strong");
    // Its transcript is stored with Work, under the attempt's own thread.
    assert.ok(
      outcome?.calls.some(
        (call) => call.kind === "native_state.append" && !call.thread,
      ),
    );
  },
};

const multiTurnResume: ClaudeScenario = {
  name: "multi-turn-resume",
  description: "A second turn resumes the thread and sees the first.",
  model: (request) => {
    if (lastUser(request).includes("Remember the word mango"))
      return text("Noted: mango.");
    if (lastUser(request).includes("Which word")) {
      return sent(request).includes("Noted: mango.")
        ? text("The word was mango.")
        : text("I do not know.");
    }
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "multi-turn-resume",
          turn: 1,
          text: "Remember the word mango",
        }),
    },
    {
      start: (context) => {
        const first = context.previous[0];
        assert.ok(first?.thread);
        return scenarioAttempt({
          context,
          scenario: "multi-turn-resume",
          turn: 2,
          text: "Which word did I ask you to remember?",
          thread: {
            mode: "resume",
            providerThreadId: first.attempt.thread.providerThreadId,
            nativeRef: first.thread,
          },
        });
      },
    },
  ],
  check: ([first, second]) => {
    settled(first, "completed");
    settled(second, "completed");
    assert.equal(reply(second), "The word was mango.");
    assert.equal(
      second?.thread?.id,
      first?.thread?.id,
      "the same native thread",
    );
    assert.ok(
      second?.calls.some(
        (call) => call.kind === "native_state.load" && !call.thread,
      ),
      "the stored transcript was loaded",
    );
  },
};

const toolUse: ClaudeScenario = {
  name: "tool-use",
  description: "Bash, Read and Edit, each reported as its own item.",
  files: { "README.md": "hello\n" },
  model: (request, { cwd }) => {
    const last = lastUser(request);
    if (last.includes("Tidy the readme"))
      return {
        blocks: [
          { type: "text", text: "Looking first." },
          {
            type: "tool_use",
            id: "toolu_fixture_bash",
            name: "Bash",
            input: { command: "echo hi", description: "Say hi" },
          },
          {
            type: "tool_use",
            id: "toolu_fixture_read",
            name: "Read",
            input: { file_path: path.join(cwd, "README.md") },
          },
        ],
      };
    if (last.includes("toolu_fixture_read"))
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_edit",
            name: "Edit",
            input: {
              file_path: path.join(cwd, "README.md"),
              old_string: "hello",
              new_string: "hello, tidy",
            },
          },
        ],
      };
    if (last.includes("toolu_fixture_edit")) return text("Tidied.");
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "tool-use",
          turn: 1,
          text: "Tidy the readme",
        }),
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "completed");
    const [command] = itemsOfKind(outcome, "command");
    assert.equal(command?.item.command, "echo hi");
    assert.equal(command?.item.description, "Say hi");
    assert.equal(command?.item.output, "hi");
    assert.equal(command?.item.exitCode, 0);
    assert.equal(command?.status, "completed");
    const [read] = itemsOfKind(outcome, "tool_call");
    assert.equal(read?.item.tool, "Read");
    assert.equal(read?.status, "completed");
    const [edit] = itemsOfKind(outcome, "file_change");
    assert.match(String(edit?.item.path), /README\.md$/);
    assert.equal(edit?.item.change, "modified");
    assert.equal(edit?.status, "completed");
    assert.match(reply(outcome), /Tidied\./);
  },
};

const askUserQuestion: ClaudeScenario = {
  name: "ask-user-question",
  description:
    "AskUserQuestion becomes a question request; the answer reaches the model.",
  model: (request) => {
    const last = lastUser(request);
    if (last.includes("Pick a theme"))
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_ask",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which theme?",
                  header: "Theme",
                  multiSelect: false,
                  options: [
                    { label: "Orange", description: "Warm" },
                    { label: "Blue", description: "Cool" },
                  ],
                },
              ],
            },
          },
        ],
      };
    if (last.includes("toolu_fixture_ask"))
      return last.includes("Orange")
        ? text("Orange it is.")
        : text("No answer arrived.");
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "ask-user-question",
          turn: 1,
          text: "Pick a theme for me",
        }),
      host: {
        answer: ({ request }) =>
          request.kind === "question"
            ? { kind: "question", answers: ["Orange"] }
            : undefined,
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "completed");
    const [opened] = eventsOf(outcome, "request.opened");
    assert.equal(opened?.request.kind, "question");
    assert.equal(opened?.key, "question:toolu_fixture_ask");
    assert.equal(opened?.request.questions?.[0]?.question, "Which theme?");
    assert.equal(opened?.request.questions?.[0]?.options.length, 2);
    assert.equal(reply(outcome), "Orange it is.");
    assert.equal(
      itemsOfKind(outcome, "tool_call").length,
      0,
      "the question is no tool row",
    );
  },
};

const mcpApproval: ClaudeScenario = {
  name: "mcp-approval",
  description:
    "A policed MCP tool asks; the first call is approved, the second denied.",
  model: (request) => {
    const last = lastUser(request);
    if (last.includes("Look up two words"))
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_lookup_1",
            name: "mcp__fixture__lookup",
            input: { word: "alpha" },
          },
        ],
      };
    if (last.includes("toolu_fixture_lookup_1"))
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_lookup_2",
            name: "mcp__fixture__lookup",
            input: { word: "beta" },
          },
        ],
      };
    if (last.includes("toolu_fixture_lookup_2"))
      return text("One looked up, one refused.");
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "mcp-approval",
          turn: 1,
          text: "Look up two words",
          overrides: {
            mcpServers: { fixture: context.fixtureServer },
            toolPolicies: { fixture: [{ default: "ask" }] },
          },
        }),
      host: {
        answer: ({ key, request }) =>
          request.kind === "approval"
            ? {
                kind: "approval",
                decision: key === "approval:1" ? "approved" : "denied",
              }
            : undefined,
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "completed");
    const approvals = eventsOf(outcome, "request.opened").filter(
      (event) => event.request.kind === "approval",
    );
    assert.equal(approvals.length, 2);
    assert.equal(approvals[0]?.request.approval?.tool?.name, "lookup");
    assert.equal(approvals[0]?.request.approval?.tool?.server, "fixture");
    const calls = itemsOfKind(outcome, "tool_call");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.item.server, "fixture");
    assert.equal(calls[0]?.status, "completed");
    assert.deepEqual(calls[0]?.item.result, {
      word: "alpha",
      meaning: "a fixture word",
    });
    assert.equal(calls[1]?.status, "failed");
    assert.ok(String(calls[1]?.item.error).length > 0);
  },
};

const hostTool: ClaudeScenario = {
  name: "host-tool",
  description:
    "A host tool offered with its JSON Schema runs through the host.",
  model: (request) => {
    const last = lastUser(request);
    if (last.includes("Read my open tab")) {
      const schema = JSON.stringify(
        toolSchema(request, "mcp__workspace__read_tab"),
      );
      if (!schema.includes('"key"')) return unexpected(request);
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_tab",
            name: "mcp__workspace__read_tab",
            input: { key: "tab-1" },
          },
        ],
      };
    }
    if (last.includes("toolu_fixture_tab"))
      return last.includes("Release notes")
        ? text("The tab holds the release notes.")
        : unexpected(request);
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "host-tool",
          turn: 1,
          text: "Read my open tab",
          overrides: {
            hostTools: [
              {
                name: "read_tab",
                description: "Read an open workspace tab by its key.",
                inputSchema: {
                  type: "object",
                  properties: {
                    key: { type: "string", description: "The tab's key" },
                  },
                  required: ["key"],
                },
              },
            ],
          },
        }),
      host: {
        tool: ({ name }) =>
          name === "read_tab"
            ? {
                content: [{ type: "text", text: "Release notes for 1.2" }],
                structured: { title: "Release notes", version: "1.2" },
              }
            : { content: [{ type: "text", text: "unknown" }], isError: true },
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "completed");
    const call = outcome?.calls.find((entry) => entry.kind === "tool");
    assert.equal(call?.kind === "tool" ? call.name : undefined, "read_tab");
    assert.deepEqual(call?.kind === "tool" ? call.input : undefined, {
      key: "tab-1",
    });
    assert.equal(
      call?.kind === "tool" ? call.itemKey : undefined,
      "toolu_fixture_tab",
    );
    const [item] = itemsOfKind(outcome, "tool_call");
    assert.equal(item?.item.tool, "mcp__workspace__read_tab");
    assert.equal(item?.item.server, "workspace");
    assert.deepEqual(item?.item.result, {
      title: "Release notes",
      version: "1.2",
    });
    assert.equal(reply(outcome), "The tab holds the release notes.");
  },
};

const steer: ClaudeScenario = {
  name: "steer",
  description: "Input steered mid-turn joins the running turn.",
  model: (request) => {
    const last = lastUser(request);
    if (last.includes("Run the slow check"))
      return {
        blocks: [
          { type: "text", text: "Starting the check." },
          {
            type: "tool_use",
            id: "toolu_fixture_slow",
            name: "Bash",
            input: {
              command: "sleep 2; echo checked",
              description: "Slow check",
            },
          },
        ],
      };
    if (last.includes("toolu_fixture_slow"))
      return last.includes("Also mention the steer")
        ? text("Checked, and steered.")
        : text("Checked.");
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "steer",
          turn: 1,
          text: "Run the slow check",
        }),
      host: {
        onEvent: (event, control) => {
          if (event.type === "item.started" && event.item.kind === "command")
            control.steer({
              itemId: "item-steer-steered",
              text: "Also mention the steer",
            });
        },
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "completed");
    assert.deepEqual(
      eventsOf(outcome, "input.consumed").flatMap((event) => event.itemIds),
      ["item-steer-steered"],
    );
    assert.match(reply(outcome), /Checked, and steered\./);
    const steerAck = [...(outcome?.acks.entries() ?? [])].find(
      ([id]) => id === "cmd-2",
    );
    assert.deepEqual(
      steerAck,
      ["cmd-2", undefined],
      "the steer was taken natively",
    );
  },
};

const interrupt: ClaudeScenario = {
  name: "interrupt",
  description:
    "An interrupt mid-answer stops the turn; the thread stays usable.",
  model: (request) =>
    lastUser(request).includes("Write a long story")
      ? {
          blocks: [{ type: "text", text: "Once upon a time, far away." }],
          holdMs: 8_000,
        }
      : unexpected(request),
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "interrupt",
          turn: 1,
          text: "Write a long story",
        }),
      host: {
        onEvent: (event, control) => {
          if (event.type === "item.delta")
            control.interrupt("The person stopped it");
        },
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "interrupted");
    const [message] = itemsOfKind(outcome, "assistant_message");
    assert.equal(message?.status, "cancelled");
    assert.match(String(message?.item.text), /^Once upon/);
  },
};

/** A native subagent's scripted model: delegate, list, report. */
function subagentModel(input: { scenario: string }) {
  return (request: ScriptedRequest): ScriptedReply => {
    const first = firstUser(request);
    const last = lastUser(request);
    if (first.includes("List the files here")) {
      if (last.includes("toolu_fixture_sub_ls"))
        return text("Found README.md.");
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_sub_ls",
            name: "Bash",
            input: { command: "ls", description: "List files" },
          },
        ],
      };
    }
    if (last.includes(`Delegate the listing (${input.scenario})`)) {
      const tool = toolNames(request).includes("Agent") ? "Agent" : "Task";
      return {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fixture_task",
            name: tool,
            input: {
              description: "List files",
              prompt: "List the files here and report them.",
              subagent_type: "general-purpose",
            },
          },
        ],
      };
    }
    // A background subagent reports through a task notification.
    if (last.includes("<task-notification>"))
      return text("The subagent found README.md.");
    if (last.includes("Async agent launched"))
      return text("The subagent is working.");
    if (last.includes("toolu_fixture_task"))
      return text("The subagent found README.md.");
    return unexpected(request);
  };
}

function checkSubagent(outcome: AttemptOutcome | undefined): void {
  settled(outcome, "completed");
  const [agent] = itemsOfKind(outcome, "subagent");
  assert.equal(agent?.key, "toolu_fixture_task");
  assert.equal(agent?.item.title, "List files");
  assert.equal(agent?.item.agentType, "general-purpose");
  assert.equal(agent?.status, "completed");
  assert.match(String(agent?.item.result), /README\.md/);
  const [nested] = itemsOfKind(outcome, "command");
  assert.equal(nested?.item.command, "ls");
  assert.equal(nested?.parentKey, "toolu_fixture_task");
  assert.equal(nested?.status, "completed");
  // The subagent's own prose stays its own.
  assert.ok(!reply(outcome).split("\n").includes("Found README.md."));
  assert.match(reply(outcome), /The subagent found README\.md\.$/);
}

const subagent: ClaudeScenario = {
  name: "subagent",
  description:
    "A native subagent the CLI runs in the background: its work nests under its item, and the turn waits for its report.",
  files: { "README.md": "hello\n" },
  model: subagentModel({ scenario: "subagent" }),
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "subagent",
          turn: 1,
          text: "Delegate the listing (subagent)",
        }),
    },
  ],
  check: ([outcome]) => checkSubagent(outcome),
};

const subagentForeground: ClaudeScenario = {
  name: "subagent-foreground",
  description:
    "With the host owning background work, a native subagent runs in the foreground and its result completes it.",
  files: { "README.md": "hello\n" },
  model: subagentModel({ scenario: "subagent-foreground" }),
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "subagent-foreground",
          turn: 1,
          text: "Delegate the listing (subagent-foreground)",
          overrides: { options: { memory: false, hostOwnsBackground: true } },
        }),
    },
  ],
  check: ([outcome]) => checkSubagent(outcome),
};

const errorAuth: ClaudeScenario = {
  name: "error-auth",
  description:
    "The provider rejects the key: a failed turn of kind auth, safe to retry.",
  model: () => ({
    error: {
      status: 401,
      type: "authentication_error",
      message: "invalid x-api-key",
    },
  }),
  attempts: [
    {
      start: (context) => {
        const attempt = scenarioAttempt({
          context,
          scenario: "error-auth",
          turn: 1,
          text: "Hello?",
        });
        // The CLI retries a rejected key ten times by default.
        return {
          ...attempt,
          env: { ...attempt.env, CLAUDE_CODE_MAX_RETRIES: "0" },
        };
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "failed");
    const error = eventsOf(outcome, "turn.completed")[0]?.error;
    assert.equal(error?.kind, "auth");
    assert.equal(error?.retrySafe, true);
    assert.equal(
      itemsOfKind(outcome, "assistant_message").length,
      0,
      "the error is no answer",
    );
  },
};

const errorRateLimit: ClaudeScenario = {
  name: "error-rate-limit",
  description: "The provider rate-limits: a failed turn of kind rate_limit.",
  model: () => ({
    error: {
      status: 429,
      type: "rate_limit_error",
      message: "Number of requests has exceeded your rate limit",
    },
  }),
  attempts: [
    {
      start: (context) => {
        const attempt = scenarioAttempt({
          context,
          scenario: "error-rate-limit",
          turn: 1,
          text: "Hello?",
        });
        return {
          ...attempt,
          env: { ...attempt.env, CLAUDE_CODE_MAX_RETRIES: "0" },
        };
      },
    },
  ],
  check: ([outcome]) => {
    settled(outcome, "failed");
    const error = eventsOf(outcome, "turn.completed")[0]?.error;
    assert.equal(error?.kind, "rate_limit");
    assert.equal(error?.retrySafe, true);
  },
};

const restore: ClaudeScenario = {
  name: "restore",
  description:
    "A thread continues on another machine from its stored transcript.",
  model: (request) => {
    if (lastUser(request).includes("The code is 4417"))
      return text("Stored: 4417.");
    if (lastUser(request).includes("What was the code"))
      return sent(request).includes("Stored: 4417.")
        ? text("The code was 4417.")
        : text("No code here.");
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "restore",
          turn: 1,
          text: "The code is 4417",
        }),
    },
    {
      elsewhere: true,
      start: (context) => {
        const first = context.previous[0];
        assert.ok(first?.thread);
        return scenarioAttempt({
          context,
          scenario: "restore",
          turn: 2,
          text: "What was the code?",
          thread: {
            mode: "restore",
            providerThreadId: first.attempt.thread.providerThreadId,
            nativeRef: first.thread,
          },
        });
      },
    },
  ],
  check: ([first, second]) => {
    settled(first, "completed");
    settled(second, "completed");
    assert.notEqual(
      second?.attempt.workingDirectory,
      first?.attempt.workingDirectory,
    );
    assert.equal(reply(second), "The code was 4417.");
  },
};

const fork: ClaudeScenario = {
  name: "fork",
  description:
    "A fork through the first turn sees only that turn, on a new native thread.",
  model: (request) => {
    const last = lastUser(request);
    if (last.includes("First word: apple")) return text("Apple noted.");
    if (last.includes("Second word: banana")) return text("Banana noted.");
    if (last.includes("Which words"))
      return sent(request).includes("banana")
        ? text("Apple and banana.")
        : text("Only apple.");
    return unexpected(request);
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "fork",
          turn: 1,
          text: "First word: apple",
        }),
    },
    {
      start: (context) => {
        const first = context.previous[0];
        assert.ok(first?.thread);
        return scenarioAttempt({
          context,
          scenario: "fork",
          turn: 2,
          text: "Second word: banana",
          thread: {
            mode: "resume",
            providerThreadId: first.attempt.thread.providerThreadId,
            nativeRef: first.thread,
          },
        });
      },
    },
    {
      start: (context) => {
        const first = context.previous[0];
        const through = eventsOf(first, "turn.completed")[0]?.ref;
        assert.ok(first?.thread && through);
        return scenarioAttempt({
          context,
          scenario: "fork",
          turn: 3,
          text: "Which words have I told you?",
          thread: {
            mode: "fork",
            providerThreadId: stableUuid("fork:forked-thread"),
            source: first.thread,
            throughTurnRef: through,
          },
          overrides: { sessionId: "session-fork-copy" },
        });
      },
    },
  ],
  check: ([first, second, forked]) => {
    settled(first, "completed");
    settled(second, "completed");
    settled(forked, "completed");
    assert.equal(reply(forked), "Only apple.");
    assert.ok(forked?.thread && first?.thread);
    assert.notEqual(
      forked.thread.id,
      first.thread.id,
      "a fork is a new native thread",
    );
    assert.ok(
      forked.calls.some(
        (call) =>
          call.kind === "native_state.load" && call.thread === first.thread?.id,
      ),
      "the fork read its source thread",
    );
    assert.ok(
      forked.calls.some(
        (call) => call.kind === "native_state.append" && !call.thread,
      ),
      "the fork wrote its own thread",
    );
  },
};

export const CLAUDE_SCENARIOS: readonly ClaudeScenario[] = [
  simpleReply,
  multiTurnResume,
  toolUse,
  askUserQuestion,
  mcpApproval,
  hostTool,
  steer,
  interrupt,
  subagent,
  subagentForeground,
  errorAuth,
  errorRateLimit,
  restore,
  fork,
];
