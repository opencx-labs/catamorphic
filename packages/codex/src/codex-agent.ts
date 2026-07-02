import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import { buildPluginsPreamble, stagePluginDocs } from "@catamorphic/sandbox";
import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";

/**
 * Coding agent backed by the OpenAI Codex SDK. The Codex CLI runs on the
 * **host machine** and operates on a local working directory — use it when
 * the project checkout the agent should edit lives on the same filesystem
 * as the server (or when the host itself is the isolation boundary, e.g. a
 * CI runner). For agents that drive a remote dev sandbox, see
 * `@catamorphic/flue`.
 */
export class CodexAgent implements CodingAgentProvider {
  readonly name = "codex";
  private readonly client: Codex;
  private readonly threads = new Map<string, Thread>();

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    env?: Record<string, string>;
  }) {
    this.client = new Codex({
      apiKey: opts?.apiKey,
      baseUrl: opts?.baseUrl,
      env: opts?.env,
    });
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    await stagePluginDocs(opts.workingDirectory, opts.attachedPlugins);
    const preamble = buildPluginsPreamble(opts.attachedPlugins);
    const kickoff = [preamble, opts.systemPrompt ?? ""]
      .filter(Boolean)
      .join("\n\n");

    const thread = this.client.startThread({
      workingDirectory: opts.workingDirectory,
    });

    const { events } = await thread.runStreamed(kickoff);
    let threadId: string | null = null;
    for await (const event of events) {
      if (event.type === "thread.started") {
        threadId = event.thread_id;
        break;
      }
    }

    const resolvedId = threadId ?? crypto.randomUUID();
    this.threads.set(resolvedId, thread);

    return {
      providerSessionId: resolvedId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async resumeSession(providerSessionId: string): Promise<ProviderSession> {
    const existing = this.threads.get(providerSessionId);
    if (existing) {
      return {
        providerSessionId,
        sandboxId: "",
        workingDirectory: "",
      };
    }

    const thread = this.client.resumeThread(providerSessionId);
    this.threads.set(providerSessionId, thread);

    return {
      providerSessionId,
      sandboxId: "",
      workingDirectory: "",
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    const thread = this.threads.get(session.providerSessionId);
    if (!thread) {
      yield { type: "error", content: "Thread not found" };
      return;
    }

    const { events } = await thread.runStreamed(message);

    for await (const event of events) {
      const mapped = mapEvent(event);
      if (mapped) {
        yield mapped;
      }
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
    this.threads.delete(session.providerSessionId);
  }
}

function mapEvent(event: ThreadEvent): AgentEvent | null {
  switch (event.type) {
    case "item.completed":
      return mapItemEvent(event.item);
    case "turn.completed":
      return { type: "done" };
    case "turn.failed":
      return { type: "error", content: event.error.message };
    case "error":
      return { type: "error", content: event.message };
    default:
      return null;
  }
}

function mapItemEvent(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case "command_execution":
      return {
        type: "command",
        content: `${item.command}\n${item.aggregated_output}`,
      };
    case "file_change":
      return {
        type: "file_edit",
        filePath: item.changes[0]?.path,
        content: item.changes.map((c) => `${c.kind}: ${c.path}`).join("\n"),
      };
    case "agent_message":
      return { type: "text", content: item.text };
    case "mcp_tool_call":
      return {
        type: "tool_call",
        toolName: `${item.server}/${item.tool}`,
        toolInput: item.arguments,
      };
    case "error":
      return { type: "error", content: item.message };
    default:
      return null;
  }
}
