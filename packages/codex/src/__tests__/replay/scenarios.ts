import path from "node:path";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  type AttemptStart,
  type HarnessEvent,
  RUNNER_PROTOCOL_VERSION,
} from "@catamorphic/agent-protocol/runner";
import type { AttemptResult, HostScript } from "./driver.js";

/**
 * The replay scenarios. The recorder (`bun run record:codex-replay`) runs
 * each against the pinned Codex CLI and a scripted loopback Responses API;
 * the replay tests run the same attempts and host scripts against the
 * recorded transcript. Changing an attempt or script here means recording
 * again.
 */

/** Where a scenario runs; each value is a transcript placeholder. */
export interface ScenarioContext {
  /** The scenario's temporary directory (`{{root}}`). */
  root: string;
  /** The model API base URL (`{{model}}`). */
  model: string;
  /** The Node binary MCP fixtures run with (`{{node}}`). */
  node: string;
  /** This package's test fixtures (`{{fixtures}}`). */
  fixtures: string;
  /** The Codex executable (not recorded: replay has no process). */
  command: string;
}

/** One scripted model response, in the order Codex asks for them. */
export type ModelItem =
  | { message: string }
  | { reasoning: string[] }
  | { call: string; args: JsonValue; namespace?: string };

export type ModelResponse =
  | {
      items: ModelItem[];
      /** Pause after the first text delta, for steering into a live turn. */
      pauseMs?: number;
      /** Never finish after the first text delta (until Codex hangs up). */
      hang?: boolean;
      /** The recorder checks the request Codex sent mentions these... */
      expectInput?: string[];
      /** ...and not these (a fork must not know later turns). */
      rejectInput?: string[];
    }
  | { status: number; error: { message: string; type: string; code?: string } };

export interface ScenarioAttempt {
  build: (context: ScenarioContext, previous: AttemptResult[]) => AttemptStart;
  script?: HostScript;
}

export interface Scenario {
  name: string;
  description: string;
  model: ModelResponse[];
  attempts: ScenarioAttempt[];
}

export function attemptBase(
  context: ScenarioContext,
  input: { ordinal: number; text: string; state?: string },
): AttemptStart {
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    sessionId: "session-1",
    projectId: "project-1",
    turnId: `turn-${input.ordinal}`,
    attemptId: `attempt-${input.ordinal}`,
    reason: "initial",
    harness: "codex",
    workingDirectory: path.join(context.root, "work"),
    stateDirectory: path.join(context.root, input.state ?? "state"),
    thread: { mode: "fresh", providerThreadId: "thread-1" },
    input: {
      itemId: `input-${input.ordinal}`,
      text: input.text,
      attachments: [],
    },
    systemPrompt: "You are Work's careful coding agent.",
    context: "",
    model: "gpt-5.3-codex",
    permissions: { sandbox: "workspace-write", approvals: "on-request" },
    modelAccess: {
      kind: "gateway",
      api: "openai",
      baseUrl: context.model,
      keyFile: path.join(context.root, "model-key"),
    },
    toolPolicies: {},
    toolAnnotations: {},
    mcpServers: {},
    hostTools: [],
    plugins: [],
    env: {},
    options: {
      command: context.command,
      disableNativeGoals: true,
      config: {
        "model_providers.work.request_max_retries": 0,
        "model_providers.work.stream_max_retries": 0,
        "model_providers.work.supports_websockets": false,
        "analytics.enabled": false,
        "feedback.enabled": false,
      },
    },
  };
}

/** The native thread and its state path, from an earlier attempt. */
export function threadOf(result: AttemptResult | undefined): {
  ref: { id: string; strength: "strong" };
  statePath?: string;
} {
  const event = result?.events.find(
    (candidate): candidate is Extract<HarnessEvent, { type: "thread" }> =>
      candidate.type === "thread",
  );
  if (!event) throw new Error("The earlier attempt reported no thread");
  return {
    ref: { id: event.ref.id, strength: "strong" },
    ...(event.statePath ? { statePath: event.statePath } : {}),
  };
}

export function turnRefOf(result: AttemptResult | undefined): {
  id: string;
  strength: "strong";
} {
  const event = result?.events.find(
    (
      candidate,
    ): candidate is Extract<HarnessEvent, { type: "turn.completed" }> =>
      candidate.type === "turn.completed",
  );
  if (!event?.ref) throw new Error("The earlier attempt reported no turn ref");
  return { id: event.ref.id, strength: "strong" };
}

const approve =
  (decision: "approved" | "denied"): HostScript["answer"] =>
  (request) =>
    request.kind === "approval" ? { kind: "approval", decision } : undefined;

const once = (
  test: (event: HarnessEvent) => boolean,
  run: (act: { steer: (text: string) => void; interrupt: () => void }) => void,
): HostScript["onEvent"] => {
  let done = false;
  return (event, act) => {
    if (done || !test(event)) return;
    done = true;
    run(act);
  };
};

const firstTextDelta = (event: HarnessEvent) =>
  event.type === "item.delta" && event.field === "text";

const NOTES_TOOL = {
  name: "read_notes",
  description: "Read the session's notes.",
  inputSchema: { type: "object", properties: {} },
};

/** One 2x2 PNG, for the image attachment scenario. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4H6oERAwQCgAsagXZAojougAAAABJRU5ErkJggg==";

export const SCENARIOS: Scenario[] = [
  {
    name: "simple-reply",
    description:
      "A fresh thread streams a reasoning summary and a reply with turn context.",
    model: [
      {
        items: [
          {
            reasoning: [
              "**Greeting the person**\n\nThey said hello.",
              "Reply briefly.",
            ],
          },
          { message: "Hello! How can I help today?" },
        ],
        expectInput: ["The project is called Atlas.", "careful coding agent"],
      },
    ],
    attempts: [
      {
        build: (context) => ({
          ...attemptBase(context, { ordinal: 1, text: "Hello there" }),
          context: "The project is called Atlas.",
        }),
      },
    ],
  },
  {
    name: "multi-turn-resume",
    description:
      "Two attempts on one thread: the second resumes it by id, sends an image, and calls a host tool offered when the thread started.",
    model: [
      { items: [{ message: "Noted: the number is 7." }] },
      {
        items: [{ call: "read_notes", args: {} }],
        expectInput: ["Remember the number 7.", "input_image"],
      },
      {
        items: [{ message: "The number was 7, and the image is a pixel." }],
        expectInput: ["notes: the number is 7"],
      },
    ],
    attempts: [
      {
        build: (context) => ({
          ...attemptBase(context, {
            ordinal: 1,
            text: "Remember the number 7.",
          }),
          hostTools: [NOTES_TOOL],
        }),
      },
      {
        script: { tool: () => "notes: the number is 7" },
        build: (context, previous) => {
          const thread = threadOf(previous[0]);
          return {
            ...attemptBase(context, {
              ordinal: 2,
              text: "Which number was it, and what is in the image?",
            }),
            hostTools: [NOTES_TOOL],
            thread: {
              mode: "resume",
              providerThreadId: "thread-1",
              nativeRef: thread.ref,
              ...(thread.statePath ? { statePath: thread.statePath } : {}),
            },
            input: {
              itemId: "input-2",
              text: "Which number was it, and what is in the image?",
              attachments: [
                {
                  kind: "image",
                  name: "pixel.png",
                  mediaType: "image/png",
                  dataBase64: PIXEL,
                },
              ],
            },
          };
        },
      },
    ],
  },
  ...(["approved", "denied"] as const).map(
    (decision): Scenario => ({
      name: `command-${decision}`,
      description: `A command needs approval outside the sandbox and is ${decision}.`,
      model: [
        {
          items: [
            {
              call: "exec_command",
              args: {
                cmd: "echo approved-run",
                sandbox_permissions: "require_escalated",
                justification: "Print a marker outside the sandbox",
              },
            },
          ],
        },
        {
          items: [
            {
              message:
                decision === "approved"
                  ? "The command printed approved-run."
                  : "The command was not allowed, so I stopped.",
            },
          ],
        },
      ],
      attempts: [
        {
          build: (context) =>
            attemptBase(context, { ordinal: 1, text: "Print the marker." }),
          script: { answer: approve(decision) },
        },
      ],
    }),
  ),
  {
    name: "file-change",
    description: "The agent adds and edits files with apply_patch.",
    model: [
      {
        items: [
          {
            call: "exec_command",
            args: {
              cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: notes.txt\n+first line\n*** Update File: README.md\n@@\n-Old title\n+New title\n*** End Patch\nEOF",
            },
          },
        ],
      },
      { items: [{ message: "Added notes.txt and retitled the README." }] },
    ],
    attempts: [
      {
        build: (context) =>
          attemptBase(context, {
            ordinal: 1,
            text: "Add notes and retitle the README.",
          }),
      },
    ],
  },
  {
    name: "host-and-mcp-tools",
    description:
      "A host tool runs as a Codex dynamic tool; an MCP tool asks by policy, then its server elicits.",
    model: [
      { items: [{ call: "search_docs", args: { query: "rollout" } }] },
      {
        items: [
          { call: "inspect_window", args: {}, namespace: "mcp__computer" },
        ],
      },
      { items: [{ message: "Rollouts are JSONL, and the window is fine." }] },
    ],
    attempts: [
      {
        build: (context) => ({
          ...attemptBase(context, {
            ordinal: 1,
            text: "Look up rollouts, then inspect the window.",
          }),
          hostTools: [
            {
              name: "search_docs",
              description: "Search the project's documents.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
          mcpServers: {
            computer: {
              transport: "stdio",
              command: context.node,
              args: [path.join(context.fixtures, "computer-use-mcp.mjs")],
            },
          },
          toolPolicies: { computer: [{ default: "ask" }] },
        }),
        script: {
          tool: (name) => ({
            content: [
              { type: "text", text: `${name}: rollouts are JSONL files` },
            ],
          }),
          answer: (request) =>
            request.kind === "approval"
              ? { kind: "approval", decision: "approved" }
              : request.kind === "elicitation"
                ? { kind: "elicitation", action: "accept", content: {} }
                : undefined,
        },
      },
    ],
  },
  {
    name: "user-question",
    description:
      "The agent asks a structured question and continues with the answer.",
    model: [
      {
        items: [
          {
            call: "request_user_input",
            args: {
              questions: [
                {
                  id: "theme",
                  header: "Theme",
                  question: "Which theme should the site use?",
                  options: [
                    { label: "Orange", description: "Warm and bright" },
                    { label: "Blue", description: "Calm and cool" },
                  ],
                },
              ],
            },
          },
        ],
      },
      { items: [{ message: "Orange it is." }] },
    ],
    attempts: [
      {
        build: (context) =>
          attemptBase(context, { ordinal: 1, text: "Pick a theme with me." }),
        script: {
          answer: (request) =>
            request.kind === "question"
              ? { kind: "question", answers: ["Orange"] }
              : undefined,
        },
      },
    ],
  },
  {
    name: "steer-mid-turn",
    description:
      "The person adds input while the reply streams; Codex takes it in the same turn.",
    model: [
      { items: [{ message: "Working on the summary now." }], pauseMs: 1_500 },
      {
        items: [{ message: "Summary done, and the weather is sunny." }],
        expectInput: ["Also mention the weather."],
      },
    ],
    attempts: [
      {
        build: (context) =>
          attemptBase(context, { ordinal: 1, text: "Summarize the project." }),
        script: {
          onEvent: once(firstTextDelta, (act) =>
            act.steer("Also mention the weather."),
          ),
        },
      },
    ],
  },
  {
    name: "interrupt-mid-turn",
    description: "The person stops the turn while the reply streams.",
    model: [{ items: [{ message: "This will take a while..." }], hang: true }],
    attempts: [
      {
        build: (context) =>
          attemptBase(context, { ordinal: 1, text: "Write a long essay." }),
        script: { onEvent: once(firstTextDelta, (act) => act.interrupt()) },
      },
    ],
  },
  {
    name: "error-auth",
    description: "The model API refuses the key.",
    model: [
      {
        status: 401,
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
      {
        status: 401,
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
    ],
    attempts: [
      { build: (context) => attemptBase(context, { ordinal: 1, text: "Hi" }) },
    ],
  },
  {
    name: "error-rate-limit",
    description: "The model API is rate limited.",
    model: [
      {
        status: 429,
        error: { message: "Rate limit reached.", type: "rate_limit_exceeded" },
      },
    ],
    attempts: [
      { build: (context) => attemptBase(context, { ordinal: 1, text: "Hi" }) },
    ],
  },
  {
    name: "restore-rollout",
    description:
      "A thread mirrored from one Codex home is restored into a fresh one and continues.",
    model: [
      { items: [{ message: "Noted: the codename is Heron." }] },
      {
        items: [{ message: "The codename is Heron." }],
        expectInput: [
          "Remember the codename Heron.",
          "Noted: the codename is Heron.",
        ],
      },
    ],
    attempts: [
      {
        build: (context) =>
          attemptBase(context, {
            ordinal: 1,
            text: "Remember the codename Heron.",
            state: "state-a",
          }),
      },
      {
        build: (context, previous) => {
          const thread = threadOf(previous[0]);
          return {
            ...attemptBase(context, {
              ordinal: 2,
              text: "What is the codename?",
              state: "state-b",
            }),
            thread: {
              mode: "restore",
              providerThreadId: "thread-1",
              nativeRef: thread.ref,
              ...(thread.statePath ? { statePath: thread.statePath } : {}),
            },
          };
        },
      },
    ],
  },
  {
    name: "fork-through-turn",
    description:
      "Two turns, then a fork through the first into another home: the fork loads the source thread's stored rollout.",
    model: [
      { items: [{ message: "First: the color is green." }] },
      { items: [{ message: "Second: the color is now red." }] },
      {
        items: [{ message: "In this fork the color is green." }],
        expectInput: ["The color is green."],
        rejectInput: ["Change it to red."],
      },
      {
        items: [{ message: "Still green in the restored fork." }],
        expectInput: [
          "The color is green.",
          "In this fork the color is green.",
        ],
        rejectInput: ["Change it to red."],
      },
    ],
    attempts: [
      {
        build: (context) =>
          attemptBase(context, { ordinal: 1, text: "The color is green." }),
      },
      {
        build: (context, previous) => ({
          ...attemptBase(context, { ordinal: 2, text: "Change it to red." }),
          thread: {
            mode: "resume",
            providerThreadId: "thread-1",
            nativeRef: threadOf(previous[0]).ref,
          },
        }),
      },
      {
        build: (context, previous) => {
          const source = threadOf(previous[0]);
          return {
            ...attemptBase(context, {
              ordinal: 3,
              text: "What is the color?",
              state: "state-fork",
            }),
            thread: {
              mode: "fork",
              providerThreadId: "thread-2",
              source: source.ref,
              throughTurnRef: turnRefOf(previous[0]),
              ...(source.statePath ? { statePath: source.statePath } : {}),
            },
          };
        },
      },
      {
        // The fork restored into yet another home: its history starts in
        // the source's rollout, which the fork keeps as an ancestor.
        build: (context, previous) => {
          const fork = threadOf(previous[2]);
          return {
            ...attemptBase(context, {
              ordinal: 4,
              text: "Is it still green?",
              state: "state-fork-restored",
            }),
            thread: {
              mode: "restore",
              providerThreadId: "thread-2",
              nativeRef: fork.ref,
              ...(fork.statePath ? { statePath: fork.statePath } : {}),
            },
          };
        },
      },
    ],
  },
];

export function scenario(name: string): Scenario {
  const found = SCENARIOS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No scenario ${name}`);
  return found;
}

/** Files a scenario's working directory starts with. */
export const WORKSPACE_FILES: Record<string, string> = {
  "README.md": "Old title\n",
};
