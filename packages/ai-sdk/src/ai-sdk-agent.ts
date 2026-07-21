import path from "node:path";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import { buildPluginsPreamble, stagedPluginFiles } from "@catamorphic/sandbox";
import { type LanguageModel, type ModelMessage, ToolLoopAgent, tool } from "ai";
import { z } from "zod";

const DEFAULT_INSTRUCTIONS = `You are a coding agent working in a Catamorphic project.
Use the provided tools to inspect and edit the project in your working directory.
Read AGENTS.md and relevant .agents/skills/*/SKILL.md files before making substantial changes.
Keep changes focused, run relevant checks, and do not commit changes.`;
const MAX_TOOL_OUTPUT_LENGTH = 100_000;

export interface AiSdkCodingAgentOpts {
  /** AI SDK model supplied and configured by the host application. */
  model: LanguageModel;
  /** Provider for the remote development sandbox that contains the project. */
  sandboxProvider: SandboxProvider;
  /** Host-level instructions prepended to every session. */
  instructions?: string;
}

interface AiSdkSessionState {
  agent: ToolLoopAgent<never, ReturnType<typeof createTools>>;
  messages: ModelMessage[];
  sandboxId: string;
  workingDirectory: string;
  running: boolean;
}

/**
 * Minimal in-process coding agent built on Vercel AI SDK's ToolLoopAgent.
 * Model calls run in the host while all project IO runs in the dev sandbox.
 */
export class AiSdkCodingAgent implements CodingAgentProvider {
  readonly name = "ai-sdk";
  private readonly sessions = new Map<string, AiSdkSessionState>();

  constructor(private readonly opts: AiSdkCodingAgentOpts) {}

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
      DEFAULT_INSTRUCTIONS,
      this.opts.instructions,
      buildPluginsPreamble(opts.attachedPlugins),
      opts.systemPrompt,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const providerSessionId = crypto.randomUUID();

    this.sessions.set(providerSessionId, {
      agent: new ToolLoopAgent({
        model: this.opts.model,
        instructions,
        tools: createTools({
          provider: this.opts.sandboxProvider,
          sandboxId: opts.sandboxId,
          workingDirectory: opts.workingDirectory,
        }),
      }),
      messages: [],
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
      running: false,
    });

    return {
      providerSessionId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async resumeSession(providerSessionId: string): Promise<ProviderSession> {
    const state = this.sessions.get(providerSessionId);
    return {
      providerSessionId,
      sandboxId: state?.sandboxId ?? "",
      workingDirectory: state?.workingDirectory ?? "",
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
        content: "Session not found (host restarted?); start a new session",
      };
      return;
    }
    if (state.running) {
      yield { type: "error", content: "A message is already running" };
      return;
    }

    state.running = true;
    const requestMessages: ModelMessage[] = [
      ...state.messages,
      { role: "user", content: message },
    ];
    state.messages = requestMessages;
    let text = "";

    try {
      const result = await state.agent.stream({ messages: requestMessages });
      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          text += part.text;
          continue;
        }
        if (part.type === "tool-call") {
          if (text.trim().length > 0) {
            yield { type: "text", content: text };
            text = "";
          }
          yield mapToolCall(part.toolName, part.input);
          continue;
        }
        if (part.type === "tool-error") {
          yield {
            type: "error",
            content: `Tool ${part.toolName} failed: ${errorMessage(part.error)}`,
          };
          continue;
        }
        if (part.type === "error") {
          throw part.error;
        }
      }

      if (text.trim().length > 0) {
        yield { type: "text", content: text };
      }
      state.messages = [...requestMessages, ...(await result.responseMessages)];
      yield { type: "done" };
    } catch (error) {
      if (text.trim().length > 0) {
        yield { type: "text", content: text };
      }
      yield { type: "error", content: errorMessage(error) };
    } finally {
      state.running = false;
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
    this.sessions.delete(session.providerSessionId);
  }
}

interface ToolContext {
  provider: SandboxProvider;
  sandboxId: string;
  workingDirectory: string;
}

function createTools(context: ToolContext) {
  let mutationQueue = Promise.resolve();
  const serializeMutation = async <T>(operation: () => Promise<T>) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resolvePath = (filePath: string): string => {
    const workingDirectory = path.posix.resolve(context.workingDirectory);
    const resolved = path.posix.resolve(workingDirectory, filePath);
    if (
      resolved !== workingDirectory &&
      !resolved.startsWith(`${workingDirectory}/`)
    ) {
      throw new Error(
        `Path escapes the project working directory: ${filePath}`,
      );
    }
    return resolved;
  };

  return {
    read: tool({
      description: "Read a UTF-8 text file from the project.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
      }),
      execute: async ({ path: filePath }) =>
        truncateToolOutput(
          await context.provider.downloadFile(
            context.sandboxId,
            resolvePath(filePath),
          ),
        ),
    }),
    write: tool({
      description: "Create or replace a UTF-8 text file in the project.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
        content: z.string(),
      }),
      execute: async ({ path: filePath, content }) =>
        serializeMutation(async () => {
          const absolutePath = resolvePath(filePath);
          const relativePath = path.posix.relative(
            context.workingDirectory,
            absolutePath,
          );
          await context.provider.uploadFiles(
            context.sandboxId,
            { [relativePath]: content },
            context.workingDirectory,
          );
          return `Wrote ${relativePath}`;
        }),
    }),
    edit: tool({
      description: "Replace one exact string occurrence in a project file.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
        oldText: z.string().describe("Exact text to replace"),
        newText: z.string().describe("Replacement text"),
      }),
      execute: async ({ path: filePath, oldText, newText }) =>
        serializeMutation(async () => {
          const absolutePath = resolvePath(filePath);
          const content = await context.provider.downloadFile(
            context.sandboxId,
            absolutePath,
          );
          const first = content.indexOf(oldText);
          if (first === -1) {
            throw new Error(`Text not found in ${filePath}`);
          }
          if (content.indexOf(oldText, first + oldText.length) !== -1) {
            throw new Error(`Text occurs more than once in ${filePath}`);
          }
          const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
          const relativePath = path.posix.relative(
            context.workingDirectory,
            absolutePath,
          );
          await context.provider.uploadFiles(
            context.sandboxId,
            { [relativePath]: updated },
            context.workingDirectory,
          );
          return `Edited ${relativePath}`;
        }),
    }),
    bash: tool({
      description:
        "Run a shell command in the project sandbox. Use it for listing, searching, tests, builds, and other project operations.",
      inputSchema: z.object({
        command: z.string(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      }),
      execute: async ({ command, timeoutMs }) => {
        const result = await context.provider.executeCommand(
          context.sandboxId,
          command,
          {
            cwd: context.workingDirectory,
            timeout:
              timeoutMs === undefined ? undefined : Math.ceil(timeoutMs / 1000),
          },
        );
        return {
          exitCode: result.exitCode,
          output: truncateToolOutput(result.result),
        };
      },
    }),
  };
}

function mapToolCall(toolName: string, input: unknown): AgentEvent {
  const values = asRecord(input);
  if (toolName === "bash") {
    return {
      type: "command",
      content: typeof values?.command === "string" ? values.command : "",
    };
  }
  if (toolName === "write" || toolName === "edit") {
    return {
      type: "file_edit",
      content: toolName,
      filePath: typeof values?.path === "string" ? values.path : undefined,
    };
  }
  return { type: "tool_call", toolName, toolInput: input };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n...[output truncated]`;
}
