import fs from "node:fs/promises";
import path from "node:path";
import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { AgentEvent } from "../types.js";
import type {
  AttachedPluginForAgent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "./types.js";

/**
 * Directory name (inside the agent's working directory) where plugin docs
 * are staged. The preamble tells the agent to look here; it's kept separate
 * from the workflow author's own `node_modules/` so nothing shadows real
 * package resolution at run time.
 */
const PLUGIN_STAGE_DIR = "_plugins";

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

/**
 * Write each attached plugin's staged files under
 * `<workingDirectory>/_plugins/<scoped-package-slug>/`. We use a slug (replace
 * `/` with `__`) so directory names stay flat and easy to reference from the
 * preamble.
 */
export async function stagePluginDocs(
  workingDirectory: string,
  plugins?: AttachedPluginForAgent[],
): Promise<void> {
  if (!plugins || plugins.length === 0) return;
  for (const plugin of plugins) {
    const dir = path.join(
      workingDirectory,
      PLUGIN_STAGE_DIR,
      slugifyPackage(plugin.packageName),
    );
    await fs.mkdir(dir, { recursive: true });
    for (const [relPath, content] of Object.entries(plugin.files)) {
      const full = path.join(dir, relPath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
    }
  }
}

export function buildPluginsPreamble(
  plugins?: AttachedPluginForAgent[],
): string {
  if (!plugins || plugins.length === 0) return "";
  const lines = plugins.map((plugin) => {
    const slug = slugifyPackage(plugin.packageName);
    const fileList = Object.keys(plugin.files).sort();
    const paths = fileList
      .map((f) => `${PLUGIN_STAGE_DIR}/${slug}/${f}`)
      .join(", ");
    const description = plugin.description ? ` — ${plugin.description}` : "";
    return `- ${plugin.packageName} (${plugin.displayName})${description}. Docs: ${paths}`;
  });
  return [
    "Attached packages (available for workflows to import):",
    ...lines,
    "Read the listed doc files before using a package.",
  ].join("\n");
}

function slugifyPackage(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/\//g, "__");
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
