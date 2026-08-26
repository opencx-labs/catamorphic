import type {
  Options,
  Query,
  SDKAssistantMessage,
  SDKBackgroundTasksChangedMessage,
  SDKFilesPersistedEvent,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDeniedMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentRuntimeEvent,
  type AgentRuntimeProvider,
  type AgentRuntimeSession,
  AgentRuntimeUnsupportedError,
} from "@catamorphic/sandbox";
import { defineAgentRuntimeConformance } from "@catamorphic/sandbox/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn((config: { name: string }) => ({
    type: "sdk",
    name: config.name,
  })),
  tool: vi.fn((name: string) => ({ name })),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAgentRuntime } from "../claude-code-runtime.js";

const queryMock = vi.mocked(query);

const nativeIds = {
  init: "00000000-0000-0000-0000-000000000001",
  partial: "00000000-0000-0000-0000-000000000002",
  assistant: "00000000-0000-0000-0000-000000000003",
  toolProgress: "00000000-0000-0000-0000-000000000004",
  taskStarted: "00000000-0000-0000-0000-000000000005",
  taskProgress: "00000000-0000-0000-0000-000000000006",
  taskUpdated: "00000000-0000-0000-0000-000000000007",
  background: "00000000-0000-0000-0000-000000000008",
  hookStarted: "00000000-0000-0000-0000-000000000009",
  hookProgress: "00000000-0000-0000-0000-000000000010",
  hookResponse: "00000000-0000-0000-0000-000000000011",
  taskCompleted: "00000000-0000-0000-0000-000000000012",
  result: "00000000-0000-0000-0000-000000000013",
  filesPersisted: "00000000-0000-0000-0000-000000000014",
  deniedResult: "00000000-0000-0000-0000-000000000015",
  backgroundAssistant: "00000000-0000-0000-0000-000000000016",
  backgroundTaskStarted: "00000000-0000-0000-0000-000000000017",
  backgroundAck: "00000000-0000-0000-0000-000000000018",
  backgroundCompleted: "00000000-0000-0000-0000-000000000019",
  denialAssistant: "00000000-0000-0000-0000-000000000020",
  denialUser: "00000000-0000-0000-0000-000000000021",
  denialAdvisory: "00000000-0000-0000-0000-000000000022",
  errorResult: "00000000-0000-0000-0000-000000000023",
  arbitraryAssistant: "00000000-0000-0000-0000-000000000024",
  arbitraryResult: "00000000-0000-0000-0000-000000000025",
  terminalTaskUpdated: "00000000-0000-0000-0000-000000000026",
  terminalTaskNotification: "00000000-0000-0000-0000-000000000027",
  arbitraryRemoteResult: "00000000-0000-0000-0000-000000000028",
  nextResult: "00000000-0000-0000-0000-000000000029",
  conflictingFailed: "00000000-0000-0000-0000-000000000030",
  conflictingStopped: "00000000-0000-0000-0000-000000000031",
  failedPatch: "00000000-0000-0000-0000-000000000032",
} as const;

const sdkUsage = {
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 2,
  },
  input_tokens: 12,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  fallback_credit: {
    status: { type: "not_applied" as const, reason: "not_enabled" as const },
  },
  output_tokens: 7,
  output_tokens_details: { thinking_tokens: 1 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard" as const,
  inference_geo: "global",
  iterations: [],
  speed: "standard" as const,
};

const initMessage = {
  type: "system",
  subtype: "init",
  agents: ["reviewer"],
  apiKeySource: "user",
  betas: [],
  claude_code_version: "2.1.0",
  cwd: "/workspace/project",
  tools: ["Read", "Edit", "TodoWrite", "Agent"],
  mcp_servers: [],
  model: "claude-sonnet-4-5",
  permissionMode: "acceptEdits",
  slash_commands: ["compact"],
  output_style: "default",
  skills: ["review"],
  plugins: [],
  capabilities: ["interrupt_receipt_v1"],
  uuid: nativeIds.init,
  session_id: "provider-session",
} satisfies SDKSystemMessage;

const partialMessage = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Working" },
  },
  parent_tool_use_id: null,
  uuid: nativeIds.partial,
  session_id: "provider-session",
  ttft_ms: 25,
} satisfies SDKPartialAssistantMessage;

const assistantMessage = {
  type: "assistant",
  message: {
    id: "msg-1",
    container: null,
    context_management: null,
    diagnostics: null,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      { type: "text", text: "Working", citations: null },
      {
        type: "tool_use",
        id: "plan-call",
        name: "TodoWrite",
        input: {
          todos: [
            {
              content: "Inspect the project",
              activeForm: "Inspecting the project",
              status: "in_progress",
            },
          ],
        },
      },
      {
        type: "tool_use",
        id: "agent-call",
        name: "Agent",
        input: {
          description: "Review the changes",
          prompt: "Review them",
          subagent_type: "reviewer",
        },
      },
      {
        type: "tool_use",
        id: "edit-call",
        name: "Edit",
        input: {
          file_path: "src/app.ts",
          old_string: "before",
          new_string: "after",
        },
      },
    ],
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: sdkUsage,
  },
  parent_tool_use_id: null,
  uuid: nativeIds.assistant,
  session_id: "provider-session",
  request_id: "request-1",
} satisfies SDKAssistantMessage;

const toolProgressMessage = {
  type: "tool_progress",
  tool_use_id: "edit-call",
  tool_name: "Edit",
  parent_tool_use_id: null,
  elapsed_time_seconds: 1.5,
  uuid: nativeIds.toolProgress,
  session_id: "provider-session",
  heartbeat: true,
} satisfies SDKToolProgressMessage;

const filesPersistedMessage = {
  type: "system",
  subtype: "files_persisted",
  files: [{ filename: "src/app.ts", file_id: "file-1" }],
  failed: [{ filename: "src/failure.ts", error: "disk full" }],
  processed_at: "2026-08-24T00:00:00.000Z",
  uuid: nativeIds.filesPersisted,
  session_id: "provider-session",
} satisfies SDKFilesPersistedEvent;

const taskStartedMessage = {
  type: "system",
  subtype: "task_started",
  task_id: "task-1",
  tool_use_id: "agent-call",
  description: "Review the changes",
  subagent_type: "reviewer",
  task_type: "local_agent",
  prompt: "Review them",
  skip_transcript: false,
  uuid: nativeIds.taskStarted,
  session_id: "provider-session",
} satisfies SDKTaskStartedMessage;

const taskProgressMessage = {
  type: "system",
  subtype: "task_progress",
  task_id: "task-1",
  tool_use_id: "agent-call",
  description: "Reviewing tests",
  subagent_type: "reviewer",
  usage: { total_tokens: 30, tool_uses: 2, duration_ms: 500 },
  last_tool_name: "Grep",
  summary: "Checking coverage",
  uuid: nativeIds.taskProgress,
  session_id: "provider-session",
} satisfies SDKTaskProgressMessage;

const taskUpdatedMessage = {
  type: "system",
  subtype: "task_updated",
  task_id: "task-1",
  patch: { status: "running", description: "Reviewing tests" },
  uuid: nativeIds.taskUpdated,
  session_id: "provider-session",
} satisfies SDKTaskUpdatedMessage;

const backgroundMessage = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [
    {
      task_id: "task-1",
      task_type: "local_agent",
      description: "Review the changes",
    },
  ],
  uuid: nativeIds.background,
  session_id: "provider-session",
} satisfies SDKBackgroundTasksChangedMessage;

const hookStartedMessage = {
  type: "system",
  subtype: "hook_started",
  hook_id: "hook-1",
  hook_name: "format",
  hook_event: "PostToolUse",
  uuid: nativeIds.hookStarted,
  session_id: "provider-session",
} satisfies SDKHookStartedMessage;

const hookProgressMessage = {
  type: "system",
  subtype: "hook_progress",
  hook_id: "hook-1",
  hook_name: "format",
  hook_event: "PostToolUse",
  stdout: "formatting",
  stderr: "",
  output: "formatting",
  uuid: nativeIds.hookProgress,
  session_id: "provider-session",
} satisfies SDKHookProgressMessage;

const hookResponseMessage = {
  type: "system",
  subtype: "hook_response",
  hook_id: "hook-1",
  hook_name: "format",
  hook_event: "PostToolUse",
  output: "formatted",
  stdout: "formatted",
  stderr: "",
  exit_code: 0,
  outcome: "success",
  uuid: nativeIds.hookResponse,
  session_id: "provider-session",
} satisfies SDKHookResponseMessage;

const failedAgentResultMessage = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "agent-call",
        content: "Reviewer crashed",
        is_error: true,
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: { status: "failed", error: "Reviewer crashed" },
  uuid: nativeIds.taskCompleted,
  session_id: "provider-session",
} satisfies SDKUserMessage;

const successResult = {
  type: "result",
  subtype: "success",
  duration_ms: 1000,
  duration_api_ms: 800,
  ttft_ms: 25,
  is_error: false,
  num_turns: 1,
  result: "Working",
  stop_reason: "end_turn",
  total_cost_usd: 0.01,
  usage: sdkUsage,
  modelUsage: {
    "claude-sonnet-4-5": {
      inputTokens: 17,
      outputTokens: 7,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      webSearchRequests: 0,
      costUSD: 0.01,
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
  },
  permission_denials: [],
  uuid: nativeIds.result,
  session_id: "provider-session",
} satisfies SDKResultSuccess;

const backgroundAssistantMessage = {
  type: "assistant",
  message: {
    id: "msg-background",
    container: null,
    context_management: null,
    diagnostics: null,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      {
        type: "tool_use",
        id: "background-agent-call",
        name: "Agent",
        input: {
          description: "Review in background",
          prompt: "Review the change",
          subagent_type: "reviewer",
          run_in_background: true,
        },
      },
    ],
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: sdkUsage,
  },
  parent_tool_use_id: null,
  uuid: nativeIds.backgroundAssistant,
  session_id: "provider-session",
  request_id: "request-background",
} satisfies SDKAssistantMessage;

const backgroundTaskStartedMessage = {
  type: "system",
  subtype: "task_started",
  task_id: "background-task-1",
  tool_use_id: "background-agent-call",
  description: "Review in background",
  subagent_type: "reviewer",
  task_type: "local_agent",
  prompt: "Review the change",
  skip_transcript: false,
  uuid: nativeIds.backgroundTaskStarted,
  session_id: "provider-session",
} satisfies SDKTaskStartedMessage;

const backgroundAcknowledgementMessage = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "background-agent-call",
        content: "Agent is running in the background.",
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: {
    status: "async_launched",
    isAsync: true,
    agentId: "background-agent-1",
    description: "Review in background",
    prompt: "Review the change",
    outputFile: "/tmp/background-agent-1.output",
    canReadOutputFile: true,
  },
  uuid: nativeIds.backgroundAck,
  session_id: "provider-session",
} satisfies SDKUserMessage;

const backgroundTaskCompletedMessage = {
  type: "system",
  subtype: "task_notification",
  task_id: "background-task-1",
  tool_use_id: "background-agent-call",
  status: "completed",
  output_file: "/tmp/background-agent-1.output",
  summary: "Background review complete",
  usage: { total_tokens: 18, tool_uses: 2, duration_ms: 400 },
  skip_transcript: false,
  uuid: nativeIds.backgroundCompleted,
  session_id: "provider-session",
} satisfies SDKTaskNotificationMessage;

const denialAssistantMessage = {
  type: "assistant",
  message: {
    id: "msg-denial",
    container: null,
    context_management: null,
    diagnostics: null,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      {
        type: "tool_use",
        id: "denied-tool",
        name: "Bash",
        input: { command: "rm file" },
      },
    ],
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: sdkUsage,
  },
  parent_tool_use_id: null,
  uuid: nativeIds.denialAssistant,
  session_id: "provider-session",
  request_id: "request-denial",
} satisfies SDKAssistantMessage;

const denialUserMessage = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "denied-tool",
        content: "Permission denied",
        is_error: true,
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: { error: "Permission denied" },
  uuid: nativeIds.denialUser,
  session_id: "provider-session",
} satisfies SDKUserMessage;

const denialAdvisoryMessage = {
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "denied-tool",
  decision_reason_type: "rule",
  decision_reason: "destructive command policy",
  message: "Bash was denied by the project destructive-command policy.",
  uuid: nativeIds.denialAdvisory,
  session_id: "provider-session",
} satisfies SDKPermissionDeniedMessage;

const errorResult = {
  type: "result",
  subtype: "error_during_execution",
  duration_ms: 1200,
  duration_api_ms: 900,
  is_error: true,
  num_turns: 1,
  stop_reason: "api_error",
  total_cost_usd: 0.02,
  usage: sdkUsage,
  modelUsage: {
    "claude-sonnet-4-5": {
      inputTokens: 20,
      outputTokens: 4,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 6,
      webSearchRequests: 0,
      costUSD: 0.02,
      contextWindow: 100000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  errors: ["Provider execution failed"],
  terminal_reason: "api_error",
  uuid: nativeIds.errorResult,
  session_id: "provider-session",
} satisfies SDKResultError;

const arbitraryAsyncAssistantMessage = {
  type: "assistant",
  message: {
    id: "msg-arbitrary-async",
    container: null,
    context_management: null,
    diagnostics: null,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      {
        type: "tool_use",
        id: "arbitrary-async-tool",
        name: "mcp__remote__launch",
        input: { target: "preview" },
      },
    ],
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: sdkUsage,
  },
  parent_tool_use_id: null,
  uuid: nativeIds.arbitraryAssistant,
  session_id: "provider-session",
  request_id: "request-arbitrary-async",
} satisfies SDKAssistantMessage;

const arbitraryAsyncResultMessage = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "arbitrary-async-tool",
        content: "Preview launched",
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: {
    status: "async_launched",
    target: "preview",
    url: "https://preview.invalid",
  },
  uuid: nativeIds.arbitraryResult,
  session_id: "provider-session",
} satisfies SDKUserMessage;

const arbitraryRemoteResultMessage = {
  ...arbitraryAsyncResultMessage,
  tool_use_result: {
    status: "remote_launched",
    taskId: "remote-preview-task",
    target: "preview",
    url: "https://preview.invalid",
  },
  uuid: nativeIds.arbitraryRemoteResult,
} satisfies SDKUserMessage;

function terminalTaskUpdatedMessage(
  status: "completed" | "failed" | "killed",
): SDKTaskUpdatedMessage {
  const message = {
    type: "system",
    subtype: "task_updated",
    task_id: "background-task-1",
    patch: { status, description: `Background task ${status}` },
    uuid: nativeIds.terminalTaskUpdated,
    session_id: "provider-session",
  } satisfies SDKTaskUpdatedMessage;
  return message;
}

function laterTaskNotificationMessage(
  status: "completed" | "failed" | "stopped",
): SDKTaskNotificationMessage {
  const message = {
    type: "system",
    subtype: "task_notification",
    task_id: "background-task-1",
    tool_use_id: "background-agent-call",
    status,
    output_file: "/tmp/background-agent-1.output",
    summary: `Later ${status} notification`,
    usage: { total_tokens: 18, tool_uses: 2, duration_ms: 400 },
    skip_transcript: false,
    uuid: nativeIds.terminalTaskNotification,
    session_id: "provider-session",
  } satisfies SDKTaskNotificationMessage;
  return message;
}

const nextSuccessResult = {
  ...successResult,
  uuid: nativeIds.nextResult,
} satisfies SDKResultSuccess;

const conflictingFailedNotification = {
  ...laterTaskNotificationMessage("failed"),
  summary: "Conflicting failed notification",
  uuid: nativeIds.conflictingFailed,
} satisfies SDKTaskNotificationMessage;

const conflictingStoppedNotification = {
  ...laterTaskNotificationMessage("stopped"),
  summary: "Conflicting stopped notification",
  uuid: nativeIds.conflictingStopped,
} satisfies SDKTaskNotificationMessage;

const failedTaskUpdatedWithError = {
  ...terminalTaskUpdatedMessage("failed"),
  patch: {
    status: "failed",
    description: "Background review failed",
    end_time: 1_777_000_000_000,
    total_paused_ms: 125,
    error: "Reviewer process exited with code 17",
    is_backgrounded: true,
  },
  uuid: nativeIds.failedPatch,
} satisfies SDKTaskUpdatedMessage;

function nativeFixture(): SDKMessage[] {
  return [
    initMessage,
    partialMessage,
    assistantMessage,
    toolProgressMessage,
    filesPersistedMessage,
    taskStartedMessage,
    taskProgressMessage,
    taskUpdatedMessage,
    backgroundMessage,
    hookStartedMessage,
    hookProgressMessage,
    hookResponseMessage,
    failedAgentResultMessage,
    successResult,
  ];
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  if (!resolve) throw new Error("Failed to create deferred resolver");
  return { promise, resolve };
}

function racedResultQuery(message: SDKMessage) {
  const resultGate = deferred<void>();
  const interruptGate = deferred<void>();
  const generator = (async function* () {
    await resultGate.promise;
    yield message;
  })();
  const runtimeQuery = Object.assign(generator, {
    interrupt: vi.fn(async () => interruptGate.promise),
    stopTask: vi.fn(async () => undefined),
    close: vi.fn(),
  }) as unknown as Query;
  return {
    query: runtimeQuery,
    releaseResult: () => resultGate.resolve(),
    releaseInterrupt: () => interruptGate.resolve(),
  };
}

function bufferedDenialWithLateAdvisoryQuery() {
  const denialBuffered = deferred<void>();
  const releaseLateAdvisory = deferred<void>();
  const generator = (async function* () {
    yield denialAssistantMessage;
    yield denialUserMessage;
    denialBuffered.resolve();
    await releaseLateAdvisory.promise;
    yield denialAdvisoryMessage;
  })();
  const runtimeQuery = Object.assign(generator, {
    interrupt: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    close: vi.fn(),
  }) as unknown as Query;
  return {
    query: runtimeQuery,
    denialBuffered: denialBuffered.promise,
    releaseLateAdvisory: () => releaseLateAdvisory.resolve(),
  };
}

function scriptedQuery(messages: readonly SDKMessage[]): Query {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(generator, {
    interrupt: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    close: vi.fn(),
  }) as unknown as Query;
}

function observedScriptedQuery(messages: readonly SDKMessage[]) {
  const closed = deferred<void>();
  const generator = (async function* () {
    try {
      for (const message of messages) yield message;
    } finally {
      closed.resolve();
    }
  })();
  const runtimeQuery = Object.assign(generator, {
    interrupt: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    close: vi.fn(),
  }) as unknown as Query;
  return { query: runtimeQuery, closed: closed.promise };
}

function drainingResultQuery(message: SDKMessage) {
  const finish = deferred<void>();
  const closed = deferred<void>();
  const forceClosed = deferred<void>();
  let closeCount = 0;
  const generator = (async function* () {
    try {
      yield message;
      await finish.promise;
    } finally {
      closed.resolve();
    }
  })();
  const runtimeQuery = Object.assign(generator, {
    interrupt: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    close: () => {
      closeCount += 1;
      forceClosed.resolve();
      finish.resolve();
    },
  }) as unknown as Query;
  return {
    query: runtimeQuery,
    closed: closed.promise,
    forceClosed: forceClosed.promise,
    finishNaturally: () => finish.resolve(),
    closeCount: () => closeCount,
  };
}

function optionsFromLastQuery(): Options {
  const call = queryMock.mock.calls.at(-1);
  if (!call) throw new Error("query was not called");
  return call[0].options ?? {};
}

async function startSession(
  provider: AgentRuntimeProvider,
): Promise<AgentRuntimeSession> {
  return provider.startSession({
    sessionId: "claude-session",
    projectId: "project-1",
    allocationId: "allocation-1",
    workingDirectory: "/workspace/project",
    systemPrompt: "Host instructions",
  });
}

async function collectUntil(args: {
  provider: AgentRuntimeProvider;
  sessionId: string;
  after?: number;
  until: (event: AgentRuntimeEvent) => boolean;
}): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of args.provider.subscribe({
    sessionId: args.sessionId,
    after: { sequence: args.after ?? 0 },
  })) {
    events.push(event);
    if (args.until(event)) break;
  }
  return events;
}

async function replayUntilIdle(args: {
  provider: AgentRuntimeProvider;
  sessionId: string;
}): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  const iterator = args.provider
    .subscribe({ sessionId: args.sessionId, after: { sequence: 0 } })
    [Symbol.asyncIterator]();
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 15),
      ),
    ]);
    if (!next || next.done) break;
    events.push(next.value);
  }
  void iterator.return?.();
  return events;
}

function boundedConformanceProvider(
  provider: AgentRuntimeProvider,
): AgentRuntimeProvider {
  return {
    name: provider.name,
    describe: (args) => provider.describe(args),
    startSession: (args) => provider.startSession(args),
    resumeSession: (args) => provider.resumeSession(args),
    stopSession: (args) => provider.stopSession(args),
    startTurn: async (args) => {
      const turn = await provider.startTurn(args);
      await collectUntil({
        provider,
        sessionId: args.sessionId,
        until: (event) =>
          event.turnId === turn.turnId &&
          (event.type === "request.created" ||
            event.type === "turn.completed" ||
            event.type === "turn.failed"),
      });
      return turn;
    },
    retryTurn: async (args) => {
      try {
        return await provider.retryTurn(args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AgentRuntimeUnsupportedError"
        ) {
          throw new AgentRuntimeUnsupportedError({
            provider: provider.name,
            operation: "retryTurn",
          });
        }
        throw error;
      }
    },
    interruptTurn: (args) => provider.interruptTurn(args),
    respond: (args) => provider.respond(args),
    listTasks: async (args) => {
      try {
        return await provider.listTasks(args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AgentRuntimeUnsupportedError"
        ) {
          throw new AgentRuntimeUnsupportedError({
            provider: provider.name,
            operation: "listTasks",
          });
        }
        throw error;
      }
    },
    controlTask: (args) => provider.controlTask(args),
    async *subscribe(args) {
      const iterator = provider.subscribe(args)[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 15),
          ),
        ]);
        if (!next || next.done) break;
        yield next.value;
        yield next.value;
      }
      void iterator.return?.();
    },
  };
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation((input) => {
    if (input.prompt === "Request approval.") {
      const generator = (async function* () {
        const canUseTool = input.options?.canUseTool;
        if (!canUseTool) throw new Error("canUseTool was not configured");
        await canUseTool(
          "Bash",
          { command: "bun test" },
          {
            signal: new AbortController().signal,
            toolUseID: "approval-tool",
            requestId: "approval-request",
          },
        );
        yield successResult;
      })();
      return Object.assign(generator, {
        interrupt: vi.fn(async () => undefined),
        stopTask: vi.fn(async () => undefined),
        close: vi.fn(),
      }) as unknown as Query;
    }
    return scriptedQuery(nativeFixture());
  });
});

describe("ClaudeCodeAgentRuntime conformance", () => {
  defineAgentRuntimeConformance({
    create: () => boundedConformanceProvider(new ClaudeCodeAgentRuntime()),
    expected: {
      approvals: true,
      questions: true,
      tasks: false,
      operations: {
        resumeSession: true,
        retryTurn: false,
        interruptTurn: true,
      },
    },
    driver: {
      startSession: async ({ provider }) => {
        const session = await startSession(provider);
        await provider.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Seed native event state." },
        });
        await collectUntil({
          provider,
          sessionId: session.sessionId,
          until: (event) => event.type === "turn.completed",
        });
        return session;
      },
      startTurn: ({ provider, session }) =>
        provider.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Request approval." },
        }),
      responseFor: () => ({ kind: "approval", decision: "approved" }),
      controlTask: async () => {},
      assertTaskControl: () => {},
    },
  });
});

describe("ClaudeCodeAgentRuntime", () => {
  it("continues durable event sequencing from the resume cursor", async () => {
    const runtime = new ClaudeCodeAgentRuntime();
    await runtime.resumeSession({
      sessionId: "resumed-session",
      providerSessionId: "provider-session",
      projectId: "project-1",
      allocationId: "allocation-1",
      workingDirectory: "/workspace",
      after: { sequence: 41 },
    });

    const events = await collectUntil({
      provider: runtime,
      sessionId: "resumed-session",
      after: 41,
      until: (event) => event.type === "session.resumed",
    });

    expect(events[0]).toMatchObject({
      type: "session.resumed",
      sequence: 42,
    });
  });

  it("maps complete native system, assistant, plan, task, background, hook, usage, result, and turn messages", async () => {
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Implement the change." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" && event.turnId === turn.turnId,
    });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "diagnostic",
      "message.delta",
      "message.completed",
      "tool.started",
      "plan.replaced",
      "tool.started",
      "subagent.started",
      "tool.started",
      "tool.progressed",
      "workspace.changed",
      "diagnostic",
      "task.started",
      "subagent.updated",
      "task.updated",
      "subagent.updated",
      "task.updated",
      "task.updated",
      "tool.requested",
      "tool.progressed",
      "tool.completed",
      "tool.failed",
      "task.failed",
      "subagent.failed",
      "usage.updated",
      "turn.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_event, index) => index + 1),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "plan.replaced",
        plan: {
          planId: "plan-call",
          items: [
            {
              id: "plan-call:0",
              title: "Inspect the project",
              status: "in_progress",
            },
          ],
        },
      }),
    );
    expect(
      events.filter((event) => event.type === "workspace.changed"),
    ).toEqual([
      expect.objectContaining({
        type: "workspace.changed",
        providerPayloadRef: nativeIds.filesPersisted,
        changes: [{ path: "src/app.ts", kind: "modified" }],
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task.failed",
        task: expect.objectContaining({ taskId: "task-1", status: "failed" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.failed",
        subagent: expect.objectContaining({
          subagentId: "agent-call",
          status: "failed",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage.updated",
        usage: {
          inputTokens: 22,
          outputTokens: 7,
          totalTokens: 29,
          cost: 0.01,
          model: "claude-sonnet-4-5",
          contextWindow: { used: 17, limit: 200000 },
        },
      }),
    );

    const options = optionsFromLastQuery();
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Host instructions",
    });
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.allowedTools).toBeUndefined();
  });

  it("answers AskUserQuestion after the turn command returned", async () => {
    let answer: unknown;
    queryMock.mockImplementationOnce((input) => {
      const generator = (async function* () {
        const canUseTool = input.options?.canUseTool;
        if (!canUseTool) throw new Error("canUseTool was not configured");
        answer = await canUseTool(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "Which database should we use?",
                header: "Database",
                multiSelect: false,
                options: [
                  {
                    label: "PostgreSQL",
                    description: "Relational and durable",
                  },
                  { label: "SQLite", description: "Embedded and local" },
                ],
              },
            ],
          },
          {
            signal: new AbortController().signal,
            toolUseID: "question-tool",
            requestId: "question-request",
          },
        );
        yield successResult;
      })();
      return Object.assign(generator, {
        interrupt: vi.fn(async () => undefined),
        stopTask: vi.fn(async () => undefined),
        close: vi.fn(),
      }) as unknown as Query;
    });
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Choose a database." },
    });
    const beforeAnswer = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "request.created",
    });
    const request = beforeAnswer.find(
      (event) => event.type === "request.created",
    );
    if (request?.type !== "request.created") {
      throw new Error("The question request was not emitted");
    }

    await runtime.respond({
      sessionId: session.sessionId,
      requestId: request.request.requestId,
      response: { kind: "question", answers: ["PostgreSQL"] },
    });
    const afterAnswer = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      after: request.sequence,
      until: (event) => event.type === "turn.completed",
    });

    expect(answer).toEqual({
      behavior: "allow",
      updatedInput: expect.objectContaining({
        answers: { "Which database should we use?": "PostgreSQL" },
      }),
    });
    expect(afterAnswer.map((event) => event.type)).toEqual([
      "request.resolved",
      "usage.updated",
      "message.completed",
      "turn.completed",
    ]);
    expect(afterAnswer.at(-1)?.turnId).toBe(turn.turnId);
  });

  it("declares task listing and control unsupported for one-shot queries", async () => {
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);

    await expect(runtime.describe({})).resolves.toMatchObject({
      capabilities: { tasks: false },
    });
    await expect(
      runtime.listTasks({ sessionId: session.sessionId }),
    ).rejects.toMatchObject({ name: "AgentRuntimeUnsupportedError" });
    await expect(
      runtime.controlTask({
        sessionId: session.sessionId,
        taskId: "task-1",
        action: "cancel",
      }),
    ).rejects.toMatchObject({ name: "AgentRuntimeUnsupportedError" });
  });

  it("keeps a background Agent acknowledgement running until one authoritative notification terminal", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        backgroundAssistantMessage,
        backgroundTaskStartedMessage,
        backgroundAcknowledgementMessage,
        backgroundTaskCompletedMessage,
        successResult,
      ]),
    );
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Review in the background." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });
    const lifecycle = events.filter(
      (event) =>
        ("tool" in event && event.tool.toolId === "background-agent-call") ||
        ("task" in event && event.task.taskId === "background-task-1") ||
        ("subagent" in event &&
          event.subagent.subagentId === "background-agent-call"),
    );

    expect(lifecycle.map((event) => event.type)).toEqual([
      "tool.started",
      "subagent.started",
      "task.started",
      "subagent.updated",
      "tool.progressed",
      "task.updated",
      "subagent.updated",
      "tool.completed",
      "task.completed",
      "subagent.completed",
    ]);
    expect(
      lifecycle.filter((event) =>
        [
          "tool.completed",
          "tool.failed",
          "tool.cancelled",
          "task.completed",
          "task.failed",
          "task.cancelled",
          "subagent.completed",
          "subagent.failed",
        ].includes(event.type),
      ),
    ).toHaveLength(3);
  });

  it.each([
    ["async_launched", arbitraryAsyncResultMessage],
    ["remote_launched", arbitraryRemoteResultMessage],
  ] as const)(
    "does not treat arbitrary %s tool output as a background Agent acknowledgement",
    async (_status, resultMessage) => {
      queryMock.mockReturnValueOnce(
        scriptedQuery([
          arbitraryAsyncAssistantMessage,
          resultMessage,
          successResult,
        ]),
      );
      const runtime = new ClaudeCodeAgentRuntime();
      const session = await startSession(runtime);
      await runtime.startTurn({
        sessionId: session.sessionId,
        message: { role: "user", content: "Launch a preview." },
      });
      const events = await collectUntil({
        provider: runtime,
        sessionId: session.sessionId,
        until: (event) => event.type === "turn.completed",
      });

      expect(
        events
          .filter(
            (event) =>
              "tool" in event && event.tool.toolId === "arbitrary-async-tool",
          )
          .map((event) => event.type),
      ).toEqual(["tool.started", "tool.completed"]);
    },
  );

  it.each([
    {
      nativeStatus: "completed",
      normalizedStatus: "completed",
      toolType: "tool.completed",
      taskType: "task.completed",
      subagentType: "subagent.completed",
    },
    {
      nativeStatus: "failed",
      normalizedStatus: "failed",
      toolType: "tool.failed",
      taskType: "task.failed",
      subagentType: "subagent.failed",
    },
    {
      nativeStatus: "killed",
      normalizedStatus: "cancelled",
      toolType: "tool.cancelled",
      taskType: "task.cancelled",
      subagentType: "subagent.failed",
    },
  ] as const)(
    "maps terminal task_updated status $nativeStatus without waiting for a notification",
    async ({
      nativeStatus,
      normalizedStatus,
      toolType,
      taskType,
      subagentType,
    }) => {
      queryMock.mockReturnValueOnce(
        scriptedQuery([
          backgroundAssistantMessage,
          backgroundTaskStartedMessage,
          backgroundAcknowledgementMessage,
          terminalTaskUpdatedMessage(nativeStatus),
          successResult,
        ]),
      );
      const runtime = new ClaudeCodeAgentRuntime();
      const session = await startSession(runtime);
      await runtime.startTurn({
        sessionId: session.sessionId,
        message: { role: "user", content: "Run the background task." },
      });
      const events = await collectUntil({
        provider: runtime,
        sessionId: session.sessionId,
        until: (event) => event.type === "turn.completed",
      });
      const terminals = events.filter(
        (event) =>
          (("tool" in event && event.tool.toolId === "background-agent-call") ||
            ("task" in event && event.task.taskId === "background-task-1") ||
            ("subagent" in event &&
              event.subagent.subagentId === "background-agent-call")) &&
          [
            "tool.completed",
            "tool.failed",
            "tool.cancelled",
            "task.completed",
            "task.failed",
            "task.cancelled",
            "subagent.completed",
            "subagent.failed",
          ].includes(event.type),
      );

      expect(terminals.map((event) => event.type)).toEqual([
        toolType,
        taskType,
        subagentType,
      ]);
      expect(terminals.map((event) => event.providerPayloadRef)).toEqual([
        nativeIds.terminalTaskUpdated,
        nativeIds.terminalTaskUpdated,
        nativeIds.terminalTaskUpdated,
      ]);
      expect(
        terminals.flatMap((event) => {
          if ("task" in event) return event.task.status;
          if ("subagent" in event) return event.subagent.status;
          return [];
        }),
      ).toEqual([normalizedStatus, normalizedStatus]);
    },
  );

  it("does not duplicate a terminal task_updated lifecycle when notification arrives later", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        backgroundAssistantMessage,
        backgroundTaskStartedMessage,
        backgroundAcknowledgementMessage,
        terminalTaskUpdatedMessage("completed"),
        laterTaskNotificationMessage("completed"),
        successResult,
      ]),
    );
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Run the background task." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });
    const terminals = events.filter(
      (event) =>
        (("tool" in event && event.tool.toolId === "background-agent-call") ||
          ("task" in event && event.task.taskId === "background-task-1") ||
          ("subagent" in event &&
            event.subagent.subagentId === "background-agent-call")) &&
        ["tool.completed", "task.completed", "subagent.completed"].includes(
          event.type,
        ),
    );

    expect(terminals.map((event) => event.type)).toEqual([
      "tool.completed",
      "task.completed",
      "subagent.completed",
    ]);
    expect(terminals.map((event) => event.providerPayloadRef)).toEqual([
      nativeIds.terminalTaskUpdated,
      nativeIds.terminalTaskUpdated,
      nativeIds.terminalTaskUpdated,
    ]);
  });

  it("deduplicates a turn-one task terminal when its notification arrives in turn two", async () => {
    const firstStream = observedScriptedQuery([
      backgroundAssistantMessage,
      backgroundTaskStartedMessage,
      backgroundAcknowledgementMessage,
      terminalTaskUpdatedMessage("completed"),
      successResult,
    ]);
    queryMock
      .mockReturnValueOnce(firstStream.query)
      .mockReturnValueOnce(
        scriptedQuery([
          laterTaskNotificationMessage("completed"),
          nextSuccessResult,
        ]),
      );
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const firstTurn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Start the background review." },
    });
    await firstStream.closed;

    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Continue while it settles." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" && event.turnId !== firstTurn.turnId,
    });
    const terminals = events.filter(
      (event) =>
        (("tool" in event && event.tool.toolId === "background-agent-call") ||
          ("task" in event && event.task.taskId === "background-task-1") ||
          ("subagent" in event &&
            event.subagent.subagentId === "background-agent-call")) &&
        ["tool.completed", "task.completed", "subagent.completed"].includes(
          event.type,
        ),
    );

    expect(terminals.map((event) => event.type)).toEqual([
      "tool.completed",
      "task.completed",
      "subagent.completed",
    ]);
    expect(terminals.map((event) => event.providerPayloadRef)).toEqual([
      nativeIds.terminalTaskUpdated,
      nativeIds.terminalTaskUpdated,
      nativeIds.terminalTaskUpdated,
    ]);
    expect(terminals.map((event) => event.turnId)).toEqual([
      firstTurn.turnId,
      firstTurn.turnId,
      firstTurn.turnId,
    ]);
  });

  it("does not start a second query while the first result stream is still draining", async () => {
    const firstStream = drainingResultQuery(successResult);
    queryMock
      .mockReturnValueOnce(firstStream.query)
      .mockReturnValueOnce(scriptedQuery([nextSuccessResult]));
    const runtimeOptions = {
      model: "claude-test",
      postTurnDrainTimeoutMs: 1_000,
    };
    const runtime = new ClaudeCodeAgentRuntime(runtimeOptions);
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Start the first turn." },
    });
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    let secondStarted = false;
    const secondStart = runtime
      .startTurn({
        sessionId: session.sessionId,
        message: { role: "user", content: "Queue the second turn." },
      })
      .then((handle) => {
        secondStarted = true;
        return handle;
      });
    await Promise.resolve();
    const eventsWhileDraining = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });
    const resolvedWhileDraining = secondStarted;
    const startedWhileDraining = eventsWhileDraining.filter(
      (event) => event.type === "turn.started",
    ).length;

    firstStream.finishNaturally();
    await firstStream.closed;
    await secondStart;
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" &&
        event.providerPayloadRef === nativeIds.nextResult,
    });

    expect(resolvedWhileDraining).toBe(false);
    expect(startedWhileDraining).toBe(1);
  });

  it("releases the query lease at natural EOF before starting the queued turn", async () => {
    const firstStream = drainingResultQuery(successResult);
    queryMock
      .mockReturnValueOnce(firstStream.query)
      .mockReturnValueOnce(scriptedQuery([nextSuccessResult]));
    const runtimeOptions = {
      model: "claude-test",
      postTurnDrainTimeoutMs: 1_000,
    };
    const runtime = new ClaudeCodeAgentRuntime(runtimeOptions);
    const session = await startSession(runtime);
    const firstTurn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Start the first turn." },
    });
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    let secondResolved = false;
    const secondStart = runtime
      .startTurn({
        sessionId: session.sessionId,
        message: { role: "user", content: "Continue after EOF." },
      })
      .then((handle) => {
        secondResolved = true;
        return handle;
      });
    await Promise.resolve();
    const resolvedBeforeEof = secondResolved;

    firstStream.finishNaturally();
    await firstStream.closed;
    const secondTurn = await secondStart;
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" && event.turnId === secondTurn.turnId,
    });
    const firstCompleted = events.find(
      (event) =>
        event.type === "turn.completed" && event.turnId === firstTurn.turnId,
    );
    const secondStartedEvent = events.find(
      (event) =>
        event.type === "turn.started" && event.turnId === secondTurn.turnId,
    );

    expect(resolvedBeforeEof).toBe(false);
    expect(firstCompleted?.sequence).toBeLessThan(
      secondStartedEvent?.sequence ?? 0,
    );
  });

  it("force-closes a never-ending result drain at the injected deadline before starting the queued turn", async () => {
    const firstStream = drainingResultQuery(successResult);
    queryMock
      .mockReturnValueOnce(firstStream.query)
      .mockReturnValueOnce(scriptedQuery([nextSuccessResult]));
    const runtimeOptions = {
      model: "claude-test",
      postTurnDrainTimeoutMs: 5,
    };
    const runtime = new ClaudeCodeAgentRuntime(runtimeOptions);
    const session = await startSession(runtime);
    const firstTurn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Leave the first stream open." },
    });
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    const secondStart = runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Continue after forced drain." },
    });
    const closeOutcome = await Promise.race([
      firstStream.forceClosed.then(() => "force-closed" as const),
      new Promise<"deadline-missed">((resolve) =>
        setTimeout(() => resolve("deadline-missed"), 75),
      ),
    ]);
    firstStream.finishNaturally();
    await firstStream.closed;
    const secondTurn = await secondStart;
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" && event.turnId === secondTurn.turnId,
    });
    const firstCompleted = events.find(
      (event) =>
        event.type === "turn.completed" && event.turnId === firstTurn.turnId,
    );
    const secondStartedEvent = events.find(
      (event) =>
        event.type === "turn.started" && event.turnId === secondTurn.turnId,
    );

    expect(closeOutcome).toBe("force-closed");
    expect(firstStream.closeCount()).toBe(1);
    expect(firstCompleted?.sequence).toBeLessThan(
      secondStartedEvent?.sequence ?? 0,
    );
  });

  it("stopping during result drain releases the lease and prevents a queued turn from starting", async () => {
    const firstStream = drainingResultQuery(successResult);
    queryMock
      .mockReturnValueOnce(firstStream.query)
      .mockReturnValueOnce(scriptedQuery([nextSuccessResult]));
    const runtimeOptions = {
      model: "claude-test",
      postTurnDrainTimeoutMs: 1_000,
    };
    const runtime = new ClaudeCodeAgentRuntime(runtimeOptions);
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Leave the first stream open." },
    });
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    const queuedStart = runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "This turn must not start." },
    });
    await runtime.stopSession({ sessionId: session.sessionId });
    const queuedOutcome = await queuedStart.then(
      () => "started" as const,
      () => "rejected" as const,
    );
    await firstStream.closed;
    await runtime.stopSession({ sessionId: session.sessionId });
    const events = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });

    expect(queuedOutcome).toBe("rejected");
    expect(firstStream.closeCount()).toBe(1);
    expect(
      events.filter((event) => event.type === "turn.started"),
    ).toHaveLength(1);
    await expect(
      runtime.startTurn({
        sessionId: session.sessionId,
        message: { role: "user", content: "Still stopped." },
      }),
    ).rejects.toThrow("stopped");
  });

  it("maps an authoritative task notification after the turn result and ignores closed-turn assistant/tool messages", async () => {
    const stream = observedScriptedQuery([
      backgroundAssistantMessage,
      backgroundTaskStartedMessage,
      backgroundAcknowledgementMessage,
      successResult,
      denialAdvisoryMessage,
      arbitraryAsyncAssistantMessage,
      arbitraryAsyncResultMessage,
      laterTaskNotificationMessage("completed"),
    ]);
    queryMock.mockReturnValueOnce(stream.query);
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Review in the background." },
    });
    await stream.closed;
    const events = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });
    const turnCompleted = events.find(
      (event) =>
        event.type === "turn.completed" && event.turnId === turn.turnId,
    );
    const taskTerminals = events.filter(
      (event) =>
        (("tool" in event && event.tool.toolId === "background-agent-call") ||
          ("task" in event && event.task.taskId === "background-task-1") ||
          ("subagent" in event &&
            event.subagent.subagentId === "background-agent-call")) &&
        ["tool.completed", "task.completed", "subagent.completed"].includes(
          event.type,
        ),
    );

    expect(taskTerminals.map((event) => event.type)).toEqual([
      "tool.completed",
      "task.completed",
      "subagent.completed",
    ]);
    expect(taskTerminals.every((event) => event.turnId === turn.turnId)).toBe(
      true,
    );
    expect(
      taskTerminals.every(
        (event) => event.sequence > (turnCompleted?.sequence ?? 0),
      ),
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        providerPayloadRef: nativeIds.denialAdvisory,
      }),
    );
    expect(
      events.filter(
        (event) =>
          "tool" in event && event.tool.toolId === "arbitrary-async-tool",
      ),
    ).toEqual([]);
    expect(
      events
        .filter(
          (event) =>
            event.turnId === turn.turnId &&
            ["turn.completed", "turn.failed", "turn.interrupted"].includes(
              event.type,
            ),
        )
        .map((event) => event.type),
    ).toEqual(["turn.completed"]);
  });

  it("keeps the stored terminal task status when conflicting duplicate notifications arrive", async () => {
    const firstStream = observedScriptedQuery([
      backgroundAssistantMessage,
      backgroundTaskStartedMessage,
      backgroundAcknowledgementMessage,
      terminalTaskUpdatedMessage("completed"),
      successResult,
    ]);
    queryMock
      .mockReturnValueOnce(firstStream.query)
      .mockReturnValueOnce(
        scriptedQuery([
          conflictingFailedNotification,
          conflictingStoppedNotification,
          nextSuccessResult,
        ]),
      );
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Start the background review." },
    });
    await firstStream.closed;

    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Continue." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" &&
        event.providerPayloadRef === nativeIds.nextResult,
    });
    const conflicts = events.filter(
      (event) =>
        event.type === "diagnostic" &&
        (event.providerPayloadRef === nativeIds.conflictingFailed ||
          event.providerPayloadRef === nativeIds.conflictingStopped),
    );

    expect(conflicts).toEqual([
      expect.objectContaining({
        providerPayloadRef: nativeIds.conflictingFailed,
        diagnostic: {
          level: "warn",
          message:
            "Ignored conflicting task notification for background-task-1: kept completed, received failed",
        },
      }),
      expect.objectContaining({
        providerPayloadRef: nativeIds.conflictingStopped,
        diagnostic: {
          level: "warn",
          message:
            "Ignored conflicting task notification for background-task-1: kept completed, received cancelled",
        },
      }),
    ]);
    expect(
      events.filter((event) =>
        ["task.failed", "task.cancelled"].includes(event.type),
      ),
    ).toEqual([]);
  });

  it("preserves task_updated patch.error across failed task, subagent, and tool events", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        backgroundAssistantMessage,
        backgroundTaskStartedMessage,
        backgroundAcknowledgementMessage,
        failedTaskUpdatedWithError,
        successResult,
      ]),
    );
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Run the background review." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        tool: expect.objectContaining({
          toolId: "background-agent-call",
          error: "Reviewer process exited with code 17",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task.failed",
        task: expect.objectContaining({
          taskId: "background-task-1",
          description: "Reviewer process exited with code 17",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.failed",
        subagent: expect.objectContaining({
          subagentId: "background-agent-call",
          title: "Reviewer process exited with code 17",
        }),
      }),
    );
  });

  it("flushes one buffered denial before interruption and makes a late advisory diagnostic-only", async () => {
    const gated = bufferedDenialWithLateAdvisoryQuery();
    queryMock.mockReturnValueOnce(gated.query);
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Run command." },
    });
    await gated.denialBuffered;

    await runtime.interruptTurn({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      reason: "User stopped",
    });
    gated.releaseLateAdvisory();
    await vi.waitFor(async () => {
      const replay = await replayUntilIdle({
        provider: runtime,
        sessionId: session.sessionId,
      });
      expect(
        replay.some(
          (event) =>
            event.type === "diagnostic" &&
            event.providerPayloadRef === nativeIds.denialAdvisory,
        ),
      ).toBe(true);
    });
    const events = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });
    const relevant = events.filter(
      (event) =>
        (event.type === "tool.failed" && event.tool.toolId === "denied-tool") ||
        event.type === "turn.interrupted" ||
        (event.type === "diagnostic" &&
          event.providerPayloadRef === nativeIds.denialAdvisory),
    );

    expect(relevant.map((event) => event.type)).toEqual([
      "tool.failed",
      "turn.interrupted",
      "diagnostic",
    ]);
    expect(relevant[0]).toMatchObject({
      providerPayloadRef: nativeIds.denialUser,
      tool: { toolId: "denied-tool", error: "Permission denied" },
    });
  });

  it("flushes one buffered denial before session stop and makes a late advisory diagnostic-only", async () => {
    const gated = bufferedDenialWithLateAdvisoryQuery();
    queryMock.mockReturnValueOnce(gated.query);
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Run command." },
    });
    await gated.denialBuffered;

    await runtime.stopSession({ sessionId: session.sessionId });
    gated.releaseLateAdvisory();
    await vi.waitFor(async () => {
      const replay = await replayUntilIdle({
        provider: runtime,
        sessionId: session.sessionId,
      });
      expect(
        replay.some(
          (event) =>
            event.type === "diagnostic" &&
            event.providerPayloadRef === nativeIds.denialAdvisory,
        ),
      ).toBe(true);
    });
    const events = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });
    const relevant = events.filter(
      (event) =>
        (event.type === "tool.failed" && event.tool.toolId === "denied-tool") ||
        event.type === "session.stopped" ||
        (event.type === "diagnostic" &&
          event.providerPayloadRef === nativeIds.denialAdvisory),
    );

    expect(relevant.map((event) => event.type)).toEqual([
      "tool.failed",
      "session.stopped",
      "diagnostic",
    ]);
    expect(relevant[0]).toMatchObject({
      providerPayloadRef: nativeIds.denialUser,
      tool: { toolId: "denied-tool", error: "Permission denied" },
    });
  });

  it("emits only interrupted when an interrupt races a native result", async () => {
    const race = racedResultQuery(successResult);
    queryMock.mockReturnValueOnce(race.query);
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Wait." },
    });

    const interrupt = runtime.interruptTurn({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      reason: "User stopped",
    });
    await vi.waitFor(() => {
      expect(race.query.interrupt).toHaveBeenCalledOnce();
    });
    race.releaseResult();
    await Promise.resolve();
    race.releaseInterrupt();
    await interrupt;
    const events = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });

    expect(
      events
        .filter(
          (event) =>
            event.turnId === turn.turnId &&
            ["turn.completed", "turn.failed", "turn.interrupted"].includes(
              event.type,
            ),
        )
        .map((event) => event.type),
    ).toEqual(["turn.interrupted"]);
  });

  it("does not emit a turn terminal after session.stop wins a result race", async () => {
    const race = racedResultQuery(successResult);
    queryMock.mockReturnValueOnce(race.query);
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Wait." },
    });

    await runtime.stopSession({ sessionId: session.sessionId });
    race.releaseResult();
    await Promise.resolve();
    const events = await replayUntilIdle({
      provider: runtime,
      sessionId: session.sessionId,
    });
    const stopped = events.find((event) => event.type === "session.stopped");

    expect(stopped?.turnId).toBeUndefined();
    expect(
      events.filter(
        (event) =>
          event.turnId === turn.turnId &&
          ["turn.completed", "turn.failed", "turn.interrupted"].includes(
            event.type,
          ),
      ),
    ).toEqual([]);
  });

  it("deduplicates user, advisory, and result permission denials by native tool id", async () => {
    const deniedResult = {
      ...successResult,
      permission_denials: [
        {
          tool_name: "Bash",
          tool_use_id: "denied-tool",
          tool_input: { command: "rm file" },
        },
      ],
      uuid: nativeIds.deniedResult,
    } satisfies SDKResultSuccess;
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        denialAssistantMessage,
        denialUserMessage,
        denialAdvisoryMessage,
        deniedResult,
      ]),
    );
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Run command." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    expect(
      events.filter(
        (event) =>
          event.type === "tool.failed" && event.tool.toolId === "denied-tool",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "tool.failed",
        providerPayloadRef: nativeIds.denialAdvisory,
        tool: {
          toolId: "denied-tool",
          title: "Bash",
          error: "Bash was denied by the project destructive-command policy.",
        },
      }),
    ]);
  });

  it("publishes authoritative usage before a failed result terminal", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([errorResult]));
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Fail after using tokens." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.failed",
    });
    const usageEvent = events.find((event) => event.type === "usage.updated");
    const failedEvent = events.find((event) => event.type === "turn.failed");

    expect(usageEvent).toMatchObject({
      type: "usage.updated",
      providerPayloadRef: nativeIds.errorResult,
      usage: {
        inputTokens: 31,
        outputTokens: 4,
        totalTokens: 35,
        cost: 0.02,
        model: "claude-sonnet-4-5",
        contextWindow: { used: 20, limit: 100000 },
      },
    });
    expect(usageEvent?.sequence).toBeLessThan(failedEvent?.sequence ?? 0);
  });

  it("routes MCP elicitation through a typed request and resolution", async () => {
    let answer: unknown;
    queryMock.mockImplementationOnce((input) => {
      const generator = (async function* () {
        const onElicitation = input.options?.onElicitation;
        if (!onElicitation) throw new Error("onElicitation was not configured");
        answer = await onElicitation(
          {
            serverName: "github",
            message: "Enter a token",
            mode: "form",
            requestedSchema: {
              type: "object",
              properties: { token: { type: "string" } },
            },
            title: "Connect GitHub",
            displayName: "GitHub",
          },
          {
            signal: new AbortController().signal,
            requestId: "elicitation-request",
          },
        );
        yield successResult;
      })();
      return Object.assign(generator, {
        interrupt: vi.fn(async () => undefined),
        stopTask: vi.fn(async () => undefined),
        close: vi.fn(),
      }) as unknown as Query;
    });
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Connect GitHub." },
    });
    const beforeAnswer = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "request.created",
    });
    const request = beforeAnswer.find(
      (event) => event.type === "request.created",
    );
    if (request?.type !== "request.created") {
      throw new Error("The elicitation request was not emitted");
    }
    expect(request.request).toMatchObject({
      kind: "elicitation",
      origin: { kind: "mcp", id: "github", displayName: "GitHub" },
      title: "Connect GitHub",
      elicitation: {
        server: "github",
        method: "form",
        schema: expect.objectContaining({ type: "object" }),
      },
    });

    await runtime.respond({
      sessionId: session.sessionId,
      requestId: request.request.requestId,
      response: {
        kind: "elicitation",
        action: "accept",
        content: { token: "secret" },
      },
    });
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      after: request.sequence,
      until: (event) => event.type === "turn.completed",
    });

    expect(answer).toEqual({ action: "accept", content: { token: "secret" } });
  });

  it("evaluates a dynamic tool policy at use time", async () => {
    let decision: "ask" | "deny" = "ask";
    const seen: string[] = [];
    const runtime = new ClaudeCodeAgentRuntime({
      decideToolUse: async ({ toolName }) => {
        seen.push(`${toolName}:${decision}`);
        return { decision };
      },
    });
    const session = await startSession(runtime);
    queryMock.mockImplementationOnce((input) => {
      const generator = (async function* () {
        const canUseTool = input.options?.canUseTool;
        if (!canUseTool) throw new Error("canUseTool was not configured");
        decision = "deny";
        const result = await canUseTool(
          "Bash",
          { command: "pwd" },
          {
            signal: new AbortController().signal,
            toolUseID: "dynamic-tool",
            requestId: "dynamic-request",
          },
        );
        expect(result).toEqual(expect.objectContaining({ behavior: "deny" }));
        yield successResult;
      })();
      return Object.assign(generator, {
        interrupt: vi.fn(async () => undefined),
        stopTask: vi.fn(async () => undefined),
        close: vi.fn(),
      }) as unknown as Query;
    });

    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Check the directory." },
    });
    await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    expect(seen).toEqual(["Bash:deny"]);
  });

  it("cancels a parked request when its turn is interrupted", async () => {
    const runtime = new ClaudeCodeAgentRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Request approval." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "request.created",
    });
    const request = events.find((event) => event.type === "request.created");
    if (request?.type !== "request.created") {
      throw new Error("The approval request was not emitted");
    }

    await runtime.interruptTurn({
      sessionId: session.sessionId,
      turnId: turn.turnId,
    });

    await expect(
      runtime.respond({
        sessionId: session.sessionId,
        requestId: request.request.requestId,
        response: { kind: "approval", decision: "approved" },
      }),
    ).rejects.toThrow("Pending agent request not found");
    await vi.waitFor(async () => {
      await expect(
        runtime.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Continue." },
        }),
      ).resolves.toEqual(
        expect.objectContaining({ sessionId: session.sessionId }),
      );
    });
  });
});
