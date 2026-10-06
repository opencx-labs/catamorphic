import { createHash } from "node:crypto";
import path from "node:path";
import type {
  HostToolDescriptor,
  HostToolResult,
} from "@catamorphic/agent-protocol/runner";
import {
  type ConnectedMcpServer,
  flattenToolResult,
  type McpToolInfo,
} from "@catamorphic/mcp";
import {
  agentQuestionInputSchema,
  agentToolResult,
  extraToolResult,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { dynamicTool, jsonSchema, type Tool, tool } from "ai";
import { z } from "zod";
import { type ShellProvider, type ShellState, shellTools } from "./shell.js";

const MAX_TOOL_OUTPUT_LENGTH = 100_000;
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024;
const WEBFETCH_TIMEOUT_MS = 30_000;

/** The sandbox surface the built-in file and shell tools run on. */
export type AiSdkSandboxProvider = ShellProvider &
  Pick<SandboxProvider, "uploadFiles" | "downloadFile">;

/**
 * What a model tool name stands for, so its calls become the right
 * transcript items: shell commands, file changes, or tool calls.
 */
export type ToolMeta =
  | { kind: "command" }
  | { kind: "file"; change: "modified" | null }
  | { kind: "title" }
  | { kind: "ask" }
  | { kind: "tool"; server: string | null; source: "builtin" }
  | { kind: "tool"; server: string; source: "host" | "mcp" };

export interface ToolSetWithMeta {
  tools: Record<string, Tool>;
  meta: Map<string, ToolMeta>;
}

export interface WorkspaceToolContext {
  provider: AiSdkSandboxProvider;
  sandboxId: string;
  workingDirectory: string;
  /** Read-only directories beside the working directory. */
  readableRoots: readonly string[];
  /** Where the next shell command starts and this chat's background commands. */
  shell: ShellState;
  /** The Environment's budget for one foreground command (ADR 0174). */
  budgetSeconds?: number;
  /**
   * The session's environment files, which every command loads (ADRs
   * 0206, 0212).
   */
  envFiles?: readonly string[];
}

const ASK_USER_DESCRIPTION = `Ask the user one or more questions. When the tool allows blocking=false, use it to continue independent work while awaiting answers. ALWAYS use this tool instead of writing questions as plain text whenever you are asking the user something and their answer shapes what you do next. Use it when (1) you are blocked on a decision that is genuinely the user's to make, one you cannot resolve from the request, the project, or sensible defaults, e.g. choosing between data sources, schedules, external services, or destructive vs. safe variants of an operation; or (2) the user asks you to interview them, gather their preferences, or otherwise requests that you ask them questions. A request like "ask me some questions" should go through this tool, batching up to 4 questions per call and calling it again for follow-ups. For routine implementation choices, pick a sensible default and state it instead of asking. Each option needs a concise label and a description explaining its effects, implications, or trade-offs; for open-ended questions offer plausible example answers as options. The user can always answer with free text instead of picking one. If you recommend an option, make it the first one and append " (Recommended)" to its label. Do not use it to ask "should I proceed?" or to confirm work you already described.`;

const SET_TITLE_DESCRIPTION =
  "Set the title of this conversation as shown in the user's chat list and tabs. Call it once near the start of a new conversation with a concise, specific title (2-5 words, sentence case, no trailing punctuation) describing what the conversation is about. Call it again whenever the current title no longer describes the conversation: the topic moved on, the scope changed, or the original title turned out to be wrong. Don't re-title for minor detours. Examples: 'Daily sales report workflow', 'Drafting onboarding doc', 'Fixing checkout bug', 'Getting to know you'.";

/**
 * The tools every attempt has: the conversation title, questions, and web
 * access. `ask` runs one question batch and returns what the model reads.
 */
export function conversationTools(input: {
  ask: (args: {
    questions: z.output<typeof agentQuestionInputSchema>["questions"];
    blocking: boolean;
    toolCallId: string;
    abortSignal?: AbortSignal;
  }) => Promise<string>;
}): ToolSetWithMeta {
  return {
    tools: {
      set_title: tool({
        description: SET_TITLE_DESCRIPTION,
        inputSchema: z.object({
          title: z
            .string()
            .min(1)
            .max(80)
            .describe("The new conversation title (2-5 words)"),
        }),
        execute: async ({ title }) => `Conversation titled: ${title}`,
      }),
      ask_user: tool({
        description: ASK_USER_DESCRIPTION,
        inputSchema: agentQuestionInputSchema,
        execute: ({ questions, blocking }, { toolCallId, abortSignal }) =>
          input.ask({
            questions,
            blocking,
            toolCallId,
            ...(abortSignal ? { abortSignal } : {}),
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
    },
    meta: new Map<string, ToolMeta>([
      ["set_title", { kind: "title" }],
      ["ask_user", { kind: "ask" }],
      ["websearch", { kind: "tool", server: null, source: "builtin" }],
      ["webfetch", { kind: "tool", server: null, source: "builtin" }],
    ]),
  };
}

/**
 * The project tools on the session's sandbox: `read`, `write`, `edit`, and
 * the shell (`bash`, plus background commands where the sandbox runs
 * processes). Paths never escape the working directory, except reads of
 * the host's read-only roots.
 */
export function workspaceTools(context: WorkspaceToolContext): ToolSetWithMeta {
  let mutationQueue = Promise.resolve();
  const serializeMutation = async <T>(operation: () => Promise<T>) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resolveReadablePath = (filePath: string): string => {
    const resolved = path.posix.resolve(
      path.posix.resolve(context.workingDirectory),
      filePath,
    );
    if (context.readableRoots.some((root) => within(resolved, root)))
      return resolved;
    return resolveProjectPath(context.workingDirectory, filePath);
  };
  const relative = (absolutePath: string) =>
    path.posix.relative(context.workingDirectory, absolutePath);

  const shell = shellTools({
    provider: context.provider,
    sandboxId: context.sandboxId,
    root: () => context.workingDirectory,
    state: context.shell,
    ...(context.budgetSeconds ? { budgetSeconds: context.budgetSeconds } : {}),
    ...(context.envFiles ? { envFiles: context.envFiles } : {}),
  });
  const tools: Record<string, Tool> = {
    read: tool({
      description:
        "Read a UTF-8 text file from the project, or a file the user attached by its absolute path.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
      }),
      execute: async ({ path: filePath }) =>
        truncateToolOutput(
          await context.provider.downloadFile(
            context.sandboxId,
            resolveReadablePath(filePath),
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
          const relativePath = relative(
            resolveProjectPath(context.workingDirectory, filePath),
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
          const absolutePath = resolveProjectPath(
            context.workingDirectory,
            filePath,
          );
          const content = await context.provider.downloadFile(
            context.sandboxId,
            absolutePath,
          );
          const first = content.indexOf(oldText);
          if (first === -1) throw new Error(`Text not found in ${filePath}`);
          if (content.indexOf(oldText, first + oldText.length) !== -1)
            throw new Error(`Text occurs more than once in ${filePath}`);
          const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
          const relativePath = relative(absolutePath);
          await context.provider.uploadFiles(
            context.sandboxId,
            { [relativePath]: updated },
            context.workingDirectory,
          );
          return `Edited ${relativePath}`;
        }),
    }),
    ...shell,
  };
  const meta = new Map<string, ToolMeta>([
    ["read", { kind: "tool", server: null, source: "builtin" }],
    ["write", { kind: "file", change: null }],
    ["edit", { kind: "file", change: "modified" }],
    ["bash", { kind: "command" }],
  ]);
  for (const name of Object.keys(shell))
    if (!meta.has(name))
      meta.set(name, { kind: "tool", server: null, source: "builtin" });
  return { tools, meta };
}

/** A project-relative or absolute path, kept inside the working directory. */
export function resolveProjectPath(
  workingDirectory: string,
  filePath: string,
): string {
  const root = path.posix.resolve(workingDirectory);
  const resolved = path.posix.resolve(root, filePath);
  if (!within(resolved, root))
    throw new Error(`Path escapes the project working directory: ${filePath}`);
  return resolved;
}

function within(resolved: string, directory: string): boolean {
  const root = path.posix.resolve(directory);
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * The host's tools (ADR 0198 host calls): offered under their own names,
 * run by the host. `call` returns MCP-shaped content; an `isError` result
 * reads to the model as the tool's error.
 */
export function hostTools(input: {
  descriptors: readonly HostToolDescriptor[];
  call: (args: {
    name: string;
    input: unknown;
    toolCallId: string;
    abortSignal?: AbortSignal;
  }) => Promise<HostToolResult>;
}): ToolSetWithMeta {
  const tools: Record<string, Tool> = {};
  const meta = new Map<string, ToolMeta>();
  for (const descriptor of input.descriptors) {
    tools[descriptor.name] = dynamicTool({
      description: descriptor.description,
      inputSchema: toolInputSchema(descriptor.inputSchema),
      toModelOutput: ({ output }) => hostModelOutput(output),
      execute: (args, { toolCallId, abortSignal }) =>
        input.call({
          name: descriptor.name,
          input: args,
          toolCallId,
          ...(abortSignal ? { abortSignal } : {}),
        }),
    });
    meta.set(descriptor.name, {
      kind: "tool",
      server: descriptor.server ?? "workspace",
      source: "host",
    });
  }
  return { tools, meta };
}

const hostToolResultSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
      }),
    ]),
  ),
  structured: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/** A host tool's output, when it is one. */
export function parseHostToolResult(
  output: unknown,
): z.output<typeof hostToolResultSchema> | undefined {
  const parsed = hostToolResultSchema.safeParse(output);
  return parsed.success ? parsed.data : undefined;
}

function hostModelOutput(output: unknown) {
  const result = parseHostToolResult(output);
  if (!result)
    return { type: "text" as const, value: JSON.stringify(output ?? null) };
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) return { type: "error-text" as const, value: text };
  return {
    type: "content" as const,
    value: [
      ...result.content.map((part) =>
        part.type === "image"
          ? {
              type: "file" as const,
              data: { type: "data" as const, data: part.data },
              mediaType: part.mimeType,
            }
          : { type: "text" as const, text: truncateToolOutput(part.text) },
      ),
      ...(result.structured !== undefined &&
      !result.content.some((part) => part.type === "text")
        ? [{ type: "text" as const, text: JSON.stringify(result.structured) }]
        : []),
    ],
  };
}

/** Model APIs take tool names of at most 64 letters, digits, `_` and `-`. */
const MODEL_TOOL_NAME_MAX = 64;

/**
 * The name the model calls an MCP tool by: `mcp__<server>__<tool>`, with
 * what model APIs refuse (MCP allows dots, `chat.postMessage`) as `_`. A
 * name that is too long, or already names another tool (`a.b` beside
 * `a_b`), ends in a short hash of the server and tool instead.
 */
export function mcpModelToolName(args: {
  server: string;
  tool: string;
  taken: Readonly<Record<string, unknown>>;
}): string {
  const safeServer = args.server.replace(/[^A-Za-z0-9-]+/g, "_");
  const safeTool = args.tool.replace(/[^A-Za-z0-9_-]+/g, "_");
  const name = `mcp__${safeServer}__${safeTool}`;
  if (name.length <= MODEL_TOOL_NAME_MAX && !Object.hasOwn(args.taken, name))
    return name;
  const hash = createHash("sha256")
    .update(`${args.server}\0${args.tool}`)
    .digest("hex")
    .slice(0, 8);
  return `${name.slice(0, MODEL_TOOL_NAME_MAX - hash.length - 1)}_${hash}`;
}

/**
 * MCP server tools as AI SDK dynamic tools named `mcp__<server>__<tool>`
 * (the namespacing Claude Code uses, so transcripts read alike across
 * harnesses). `authorize` runs before every call and throws to refuse it;
 * the model reads the refusal as the tool's error and the turn goes on.
 */
export function mcpTools(input: {
  servers: ReadonlyMap<string, ConnectedMcpServer>;
  taken: Readonly<Record<string, unknown>>;
  authorize: (args: {
    server: string;
    tool: McpToolInfo;
    input: Record<string, unknown>;
    toolCallId: string;
    abortSignal?: AbortSignal;
  }) => Promise<void>;
}): ToolSetWithMeta {
  const tools: Record<string, Tool> = {};
  const meta = new Map<string, ToolMeta>();
  for (const [serverName, server] of input.servers) {
    for (const info of server.tools) {
      // Calls use `info.name`; the model sees a name its API accepts.
      const name = mcpModelToolName({
        server: serverName,
        tool: info.name,
        taken: { ...input.taken, ...tools },
      });
      meta.set(name, { kind: "tool", server: serverName, source: "mcp" });
      tools[name] = dynamicTool({
        description: info.description,
        inputSchema: toolInputSchema(info.inputSchema),
        toModelOutput: ({ output }) => mediaModelOutput(output),
        execute: async (args, { toolCallId, abortSignal }) => {
          const pruned = pruneEmptyOptionalArgs(
            isRecord(args) ? args : {},
            info.inputSchema,
          );
          await input.authorize({
            server: serverName,
            tool: info,
            input: pruned,
            toolCallId,
            ...(abortSignal ? { abortSignal } : {}),
          });
          abortSignal?.throwIfAborted();
          return mcpCallResult(await server.callToolRaw(info.name, pruned));
        },
      });
    }
  }
  return { tools, meta };
}

/**
 * Prefer structured content: MCP Apps views render it, and the model reads
 * JSON fine. Media results keep their images for the model; text-only
 * results stay text, and `flattenToolResult` throws on `isError` results.
 */
function mcpCallResult(raw: Record<string, unknown>): unknown {
  const blocks = z.array(z.unknown()).parse(raw.content ?? []);
  const media = blocks.flatMap((block) => {
    const image = z
      .object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ]),
      })
      .safeParse(block);
    return image.success ? [image.data] : [];
  });
  const isError = raw.isError === true;
  if (media.length > 0 && !isError) {
    const text = blocks.flatMap((block) => {
      const part = z
        .object({ type: z.literal("text"), text: z.string() })
        .safeParse(block);
      return part.success
        ? [{ type: "text" as const, text: truncateToolOutput(part.data.text) }]
        : [];
    });
    if (raw.structuredContent !== undefined)
      text.push({ type: "text", text: JSON.stringify(raw.structuredContent) });
    return agentToolResult({ content: [...text, ...media] });
  }
  if (raw.structuredContent !== undefined && !isError)
    return raw.structuredContent;
  return truncateToolOutput(
    flattenToolResult({
      content: blocks.filter(isRecord),
      ...(raw.structuredContent !== undefined
        ? { structuredContent: raw.structuredContent }
        : {}),
      isError,
    }),
  );
}

/**
 * A JSON Schema from a host or an MCP server as the AI SDK's tool input
 * schema. Servers validate their own input; the model sees the schema as is.
 */
function toolInputSchema(schema: Record<string, unknown>) {
  return jsonSchema<Record<string, unknown>>(
    // JSON Schema arrives as data; the AI SDK types it as JSONSchema7.
    schema as Parameters<typeof jsonSchema>[0],
  );
}

/**
 * Some models (OpenAI-family especially) fill every declared property and
 * send `""`/`null` for the ones they have no value for; servers that
 * validate optional fields then reject the call ("value is not a channel
 * ID" for `context_channel_id: ""`, from Slack's search tool). Drop such
 * values for optional properties, but ONLY when the property's own schema
 * could not have meant them: a `null` a schema admits (`type: [...,
 * "null"]`, `nullable`, an `anyOf` null branch, an `enum` with null) is a
 * value ("clear this field"), and so is `""` on a plain string with no
 * `format`/`pattern`/`minLength`/`enum` ruling it out. Unknown properties
 * (no schema) keep the blanket rule.
 */
export function pruneEmptyOptionalArgs(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key) => typeof key === "string")
      : [],
  );
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (required.has(key) || (value !== "" && value !== null)) {
      pruned[key] = value;
      continue;
    }
    const property = properties[key];
    const schemaOf = isRecord(property) ? property : undefined;
    const meaningful =
      value === null
        ? schemaAdmitsNull(schemaOf)
        : schemaAdmitsEmptyString(schemaOf);
    if (meaningful) pruned[key] = value;
  }
  return pruned;
}

function schemaAdmitsNull(
  property: Record<string, unknown> | undefined,
): boolean {
  if (!property) return false;
  if (property.nullable === true) return true;
  const type = property.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null")))
    return true;
  if (Array.isArray(property.enum) && property.enum.includes(null)) return true;
  for (const branchKey of ["anyOf", "oneOf"] as const) {
    const branches = property[branchKey];
    if (
      Array.isArray(branches) &&
      branches.some((branch) =>
        schemaAdmitsNull(isRecord(branch) ? branch : undefined),
      )
    )
      return true;
  }
  return false;
}

function schemaAdmitsEmptyString(
  property: Record<string, unknown> | undefined,
): boolean {
  if (!property) return false;
  const type = property.type;
  const isString =
    type === "string" || (Array.isArray(type) && type.includes("string"));
  if (!isString) return false;
  if (Array.isArray(property.enum)) return property.enum.includes("");
  if (typeof property.minLength === "number" && property.minLength > 0)
    return false;
  if (property.format !== undefined || property.pattern !== undefined)
    return false;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n...[output truncated]`;
}

/** Keep media in what the model reads; keep image bytes out of the transcript. */
export function transcriptToolResult(output: unknown): unknown {
  if (!isRecord(output) || output.kind !== "agent-tool-result") {
    const host = parseHostToolResult(output);
    if (!host) return output;
    return {
      content: host.content.map((part) =>
        part.type === "image"
          ? { type: "image", mimeType: part.mimeType }
          : part,
      ),
      ...(host.structured !== undefined ? { structured: host.structured } : {}),
      ...(host.isError ? { isError: true } : {}),
    };
  }
  return {
    content: extraToolResult(output).content.map((part) =>
      part.type === "image" ? { type: "image", mimeType: part.mimeType } : part,
    ),
  };
}

function mediaModelOutput(output: unknown) {
  const result = extraToolResult(output);
  if (result.isError)
    return {
      type: "error-text" as const,
      value: result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    };
  return {
    type: "content" as const,
    value: result.content.map((part) =>
      part.type === "image"
        ? {
            type: "file" as const,
            data: { type: "data" as const, data: part.data },
            mediaType: part.mimeType,
          }
        : part,
    ),
  };
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
  if (!response.ok)
    throw new Error(`Web search failed with status ${response.status}`);
  const result = parseMcpToolResult(await response.text());
  return result ?? "No search results found. Try a different query.";
}

const mcpTextResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string().optional() })).optional(),
  }),
});

function parseMcpToolResult(body: string): string | undefined {
  const payloads = body.trim().startsWith("{")
    ? [body.trim()]
    : body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
  for (const payload of payloads) {
    try {
      const data = mcpTextResultSchema.safeParse(JSON.parse(payload));
      const text = data.success
        ? data.data.result.content?.find((item) => item.text)?.text
        : undefined;
      if (text) return text;
    } catch {
      // skip malformed SSE payloads
    }
  }
  return undefined;
}

async function webFetch(url: string): Promise<string> {
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    throw new Error("URL must start with http:// or https://");
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
  if (!response.ok)
    throw new Error(`Fetch failed with status ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > WEBFETCH_MAX_BYTES)
    throw new Error("Response too large (exceeds 5MB limit)");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > WEBFETCH_MAX_BYTES)
    throw new Error("Response too large (exceeds 5MB limit)");
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType &&
    !/text|json|xml|javascript|markdown|html/i.test(contentType)
  )
    throw new Error(`Unsupported content type: ${contentType}`);
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
