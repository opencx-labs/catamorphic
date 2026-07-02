import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import { buildPluginsPreamble, stagedPluginFiles } from "@catamorphic/sandbox";
import type {
  FlueEvent,
  FlueHarness,
  Skill,
  ThinkingLevel,
  ToolDefinition,
} from "@flue/runtime";
import { defineAgent } from "@flue/runtime";
import {
  createFlueContext,
  type FlueContextInternal,
  resolveModel,
} from "@flue/runtime/internal";
import { catamorphicSandbox } from "./sandbox-adapter.js";

export interface FlueCodingAgentOpts {
  /**
   * Flue model specifier, e.g. `anthropic/claude-sonnet-4-6` or
   * `openai/gpt-5.5`. Provider API keys come from the host environment
   * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or a `registerProvider` call.
   */
  model: string;
  /**
   * Sandbox provider the agent operates through. The Flue harness runs on
   * the host server; all shell/file work happens inside the remote dev
   * sandbox belonging to the session.
   */
  sandboxProvider: SandboxProvider;
  /** Host-level instructions prepended to every session's system prompt. */
  instructions?: string;
  /**
   * Host-registered skills (built with `defineSkill` or imported `SKILL.md`
   * references). Per-project skills don't go here — they live in the project
   * repo under `.agents/skills/` and are discovered from the sandbox
   * workspace automatically.
   */
  skills?: Skill[];
  /** Custom model-callable tools (built with `defineTool`). */
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
}

interface FlueSessionState {
  ctx: FlueContextInternal;
  harness: FlueHarness;
  sandboxId: string;
  workingDirectory: string;
}

/**
 * Coding agent backed by the Flue agent framework (https://flueframework.com).
 *
 * Unlike agents that run inside the sandbox, the Flue harness executes in the
 * host process and drives the dev sandbox remotely through the
 * `SandboxProvider` contract — model credentials never enter the sandbox, and
 * the agent works against the project checkout that the sandbox cloned from
 * the project's origin (e.g. Cloudflare Artifacts).
 *
 * Skills resolution is two-layered:
 * - `opts.skills` — application-owned skills bundled by the host.
 * - workspace skills — discovered by Flue from `<workingDirectory>/.agents/skills/`
 *   inside the sandbox, i.e. versioned per project in the project repo.
 */
export class FlueCodingAgent implements CodingAgentProvider {
  readonly name = "flue";
  private readonly sessions = new Map<string, FlueSessionState>();

  constructor(private readonly opts: FlueCodingAgentOpts) {}

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const pluginFiles = stagedPluginFiles(opts.attachedPlugins);
    if (Object.keys(pluginFiles).length > 0) {
      await this.opts.sandboxProvider.uploadFiles(
        opts.sandboxId,
        pluginFiles,
        opts.workingDirectory,
      );
    }

    const instructions = [
      this.opts.instructions,
      buildPluginsPreamble(opts.attachedPlugins),
      opts.systemPrompt,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    const agent = defineAgent(() => ({
      model: this.opts.model,
      instructions: instructions || undefined,
      skills: this.opts.skills,
      tools: this.opts.tools,
      thinkingLevel: this.opts.thinkingLevel,
      cwd: opts.workingDirectory,
      sandbox: catamorphicSandbox({
        provider: this.opts.sandboxProvider,
        sandboxId: opts.sandboxId,
      }),
    }));

    const providerSessionId = crypto.randomUUID();
    const ctx = createFlueContext({
      id: providerSessionId,
      agentName: "catamorphic-coding-agent",
      env: {},
      agentConfig: { resolveModel },
      createDefaultEnv: () => {
        throw new Error(
          "FlueCodingAgent always supplies a sandbox; the default env should never be requested",
        );
      },
    });

    const harness = await ctx.initializeRootHarness(agent);
    this.sessions.set(providerSessionId, {
      ctx,
      harness,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    });

    return {
      providerSessionId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async resumeSession(providerSessionId: string): Promise<ProviderSession> {
    const state = this.sessions.get(providerSessionId);
    if (!state) {
      // Harness state is in-memory; a restarted host must start a fresh
      // session (the orchestration layer keeps durable message history).
      return { providerSessionId, sandboxId: "", workingDirectory: "" };
    }
    return {
      providerSessionId,
      sandboxId: state.sandboxId,
      workingDirectory: state.workingDirectory,
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(session.providerSessionId);
    if (!state) {
      yield {
        type: "error",
        content: "Session not found (host restarted?) — start a new session",
      };
      return;
    }

    const queue = new AsyncQueue<AgentEvent>();
    const mapper = new EventMapper((event) => queue.push(event));
    const unsubscribe = state.ctx.subscribeEvent((event) => {
      mapper.handle(event);
    });

    const run = (async () => {
      const flueSession = await state.harness.session();
      await flueSession.prompt(message);
    })();

    run
      .then(() => {
        mapper.flushText();
        queue.push({ type: "done" });
      })
      .catch((error: unknown) => {
        mapper.flushText();
        queue.push({
          type: "error",
          content: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        unsubscribe();
        queue.close();
      });

    yield* queue;
  }

  async dispose(session: ProviderSession): Promise<void> {
    this.sessions.delete(session.providerSessionId);
  }
}

/** Maps Flue's event stream onto catamorphic's provider-neutral AgentEvent. */
class EventMapper {
  private textBuffer = "";

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  handle(event: FlueEvent): void {
    switch (event.type) {
      case "text_delta":
        this.textBuffer += event.text;
        return;
      case "tool_start": {
        this.flushText();
        this.emit(mapToolStart(event.toolName, event.args));
        return;
      }
      case "tool": {
        if (event.isError) {
          this.flushText();
          this.emit({
            type: "error",
            content: `Tool ${event.toolName} failed: ${stringifyResult(event.result)}`,
          });
        }
        return;
      }
      case "log": {
        if (event.level === "error") {
          this.flushText();
          this.emit({ type: "error", content: event.message });
        }
        return;
      }
      default:
        return;
    }
  }

  flushText(): void {
    if (this.textBuffer.trim().length > 0) {
      this.emit({ type: "text", content: this.textBuffer });
    }
    this.textBuffer = "";
  }
}

const FILE_EDIT_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);

function mapToolStart(toolName: string, args: unknown): AgentEvent {
  const input = asRecord(args);
  if (toolName === "bash") {
    const command = typeof input?.command === "string" ? input.command : "";
    return { type: "command", content: command };
  }
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const filePath =
      typeof input?.path === "string"
        ? input.path
        : typeof input?.file_path === "string"
          ? input.file_path
          : undefined;
    return { type: "file_edit", filePath, content: toolName };
  }
  return { type: "tool_call", toolName, toolInput: args };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Minimal push-based async iterable: producers `push` values, the consumer
 * iterates until `close()`.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private pendingResolve: (() => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.buffered.push(value);
    this.pendingResolve?.();
    this.pendingResolve = undefined;
  }

  close(): void {
    this.closed = true;
    this.pendingResolve?.();
    this.pendingResolve = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.buffered.length > 0) {
        const next = this.buffered.shift();
        if (next !== undefined) yield next;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
      });
    }
  }
}
