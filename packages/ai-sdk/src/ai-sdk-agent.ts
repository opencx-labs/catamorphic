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

const DEFAULT_INSTRUCTIONS = `You are working in a Catamorphic project.
Use the provided tools to inspect and edit the project in your working directory.
Read AGENTS.md and relevant .agents/skills/*/SKILL.md files before making substantial changes.
Keep changes focused, run relevant checks, and do not commit changes.`;
const MAX_TOOL_OUTPUT_LENGTH = 100_000;
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024;
const WEBFETCH_TIMEOUT_MS = 30_000;

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
    websearch: tool({
      description:
        "Search the web and return results with content excerpts optimized for reading. Use it for up-to-date information, documentation, or anything outside the project.",
      inputSchema: z.object({
        query: z.string().describe("Web search query"),
        numResults: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Number of results to return (default 8)"),
      }),
      execute: async ({ query, numResults }) =>
        truncateToolOutput(await exaWebSearch(query, numResults ?? 8)),
    }),
    webfetch: tool({
      description:
        "Fetch a URL and return its content as text. Use it to read pages found via websearch or URLs provided by the user.",
      inputSchema: z.object({
        url: z.string().describe("The http(s) URL to fetch"),
      }),
      execute: async ({ url }) => truncateToolOutput(await webFetch(url)),
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

/** Free keyless web search via Exa's public MCP endpoint (same approach as opencode). */
async function exaWebSearch(
  query: string,
  numResults: number,
): Promise<string> {
  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults, type: "auto", livecrawl: "fallback" },
      },
    }),
    signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`);
  }
  const body = await response.text();
  const result = parseMcpToolResult(body);
  return result ?? "No search results found. Try a different query.";
}

function parseMcpToolResult(body: string): string | undefined {
  const payloads = body.trim().startsWith("{")
    ? [body.trim()]
    : body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
  for (const payload of payloads) {
    try {
      const data = JSON.parse(payload) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = data.result?.content?.find((item) => item.text)?.text;
      if (text) return text;
    } catch {
      // skip malformed SSE payloads
    }
  }
  return undefined;
}

async function webFetch(url: string): Promise<string> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept:
        "text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > WEBFETCH_MAX_BYTES
  ) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > WEBFETCH_MAX_BYTES) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType &&
    !/text|json|xml|javascript|markdown|html/i.test(contentType)
  ) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  const text = new TextDecoder().decode(buffer);
  return contentType.includes("html") ? htmlToText(text) : text;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
