import type {
  ItemPayload,
  JsonObject,
  JsonValue,
} from "@catamorphic/agent-protocol";
import type {
  HarnessEvent,
  ItemDraft,
} from "@catamorphic/agent-protocol/runner";
import { reasoningHeading } from "@catamorphic/sandbox";
import { isObject } from "./app-server.js";

type ItemStatus = "completed" | "failed" | "cancelled";

interface OpenItem {
  kind: ItemDraft["kind"];
}

/**
 * Codex thread items as Work items (ADR 0196). Keys are Codex's own item
 * ids (a file change adds its path, one item per changed file), so a
 * notification about an item always finds the item it describes.
 */
export class CodexItems {
  /** Any item but the input itself was reported: the turn did work. */
  workStarted = false;
  private readonly open = new Map<string, OpenItem>();
  private readonly reasoning = new Map<
    string,
    { text: string; started: boolean; part: number; parentKey?: string }
  >();
  private readonly fileChanges = new Map<string, Set<string>>();
  private readonly mcpCalls = new Map<
    string,
    { server: string; tool: string; input: JsonValue }
  >();
  private status?: string;
  private planKey?: string;
  /** Native subagent threads → the item that spawned them. */
  readonly childThreads = new Map<string, string>();

  constructor(
    private readonly input: {
      emit: (event: HarnessEvent) => void;
      /** The attempt's server key for a Codex MCP server key. */
      serverName: (codexKey: string) => string;
      /** The host tool server a dynamic tool belongs to. */
      hostToolServer: (tool: string) => string;
      /** Tools whose calls Work shows another way (none today). */
      hidden?: (tool: string) => boolean;
      /** A changed file as Work names it (relative to the workspace). */
      filePath?: (path: string) => string;
    },
  ) {}

  private started(
    key: string,
    item: ItemDraft,
    options: {
      parentKey?: string;
      status?: "completed" | "failed";
      /** The native item id, when it is not the key itself; null for none. */
      ref?: string | null;
    } = {},
  ): void {
    this.workStarted = true;
    if (!options.status) this.open.set(key, { kind: item.kind });
    const ref = options.ref === undefined ? key : options.ref;
    this.input.emit({
      type: "item.started",
      key,
      ...(ref ? { ref: { id: ref, strength: "strong" as const } } : {}),
      item: {
        ...item,
        ...(options.parentKey ? { parentKey: options.parentKey } : {}),
      } as ItemDraft,
      ...(options.status ? { status: options.status } : {}),
    });
  }

  private completed(
    key: string,
    status: ItemStatus,
    item?: Partial<ItemPayload>,
  ): void {
    if (!this.open.delete(key)) return;
    this.input.emit({
      type: "item.completed",
      key,
      status,
      ...(item ? { item } : {}),
    });
  }

  itemStarted(item: JsonObject, parentKey?: string): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
      case "agentMessage":
        this.started(
          id,
          { kind: "assistant_message", text: "", agentId: null },
          { parentKey },
        );
        return;
      case "reasoning":
        this.reasoning.set(id, {
          text: "",
          started: false,
          part: 0,
          ...(parentKey ? { parentKey } : {}),
        });
        return;
      case "commandExecution":
        this.started(
          id,
          {
            kind: "command",
            command: String(item.command ?? ""),
            description: null,
            output: "",
            exitCode: null,
          },
          { parentKey },
        );
        return;
      case "fileChange":
        for (const change of this.changes(item))
          this.fileStarted(id, change, parentKey);
        return;
      case "mcpToolCall": {
        const server = String(item.server ?? "");
        const tool = String(item.tool ?? "");
        const input = item.arguments ?? null;
        this.mcpCalls.set(id, { server, tool, input });
        this.started(
          id,
          {
            kind: "tool_call",
            tool: `mcp__${server}__${tool}`,
            server: this.input.serverName(server),
            description: describedBy(input),
            input,
            result: null,
            error: null,
          },
          { parentKey },
        );
        return;
      }
      case "dynamicToolCall": {
        const tool = String(item.tool ?? "");
        if (this.input.hidden?.(tool)) return;
        this.started(
          id,
          {
            kind: "tool_call",
            tool,
            server: this.input.hostToolServer(tool),
            description: describedBy(item.arguments ?? null),
            input: item.arguments ?? null,
            result: null,
            error: null,
          },
          { parentKey },
        );
        return;
      }
      case "webSearch":
        this.started(
          id,
          {
            kind: "tool_call",
            tool: "web_search",
            server: null,
            description: null,
            input: webSearchInput(item),
            result: null,
            error: null,
          },
          { parentKey },
        );
        return;
      case "collabAgentToolCall": {
        if (item.tool !== "spawnAgent") return;
        this.started(
          id,
          {
            kind: "subagent",
            title: subagentTitle(item.prompt),
            agentType: typeof item.model === "string" ? item.model : null,
            childSessionId: null,
            result: null,
          },
          { parentKey },
        );
        this.linkChildren(item, id);
        return;
      }
    }
  }

  itemCompleted(item: JsonObject, parentKey?: string): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
      case "agentMessage":
        if (!this.open.has(id))
          this.started(
            id,
            { kind: "assistant_message", text: "", agentId: null },
            { parentKey },
          );
        this.completed(id, "completed", { text: String(item.text ?? "") });
        return;
      case "reasoning": {
        const state = this.reasoning.get(id);
        this.reasoning.delete(id);
        const text = Array.isArray(item.summary)
          ? item.summary.filter((part) => typeof part === "string").join("\n\n")
          : (state?.text ?? "");
        if (!state?.started) {
          if (!text) return;
          this.started(
            id,
            { kind: "reasoning", text },
            { parentKey, status: "completed" },
          );
          this.statusFrom(text);
          return;
        }
        this.statusFrom(text);
        this.completed(id, "completed", { text });
        return;
      }
      case "commandExecution": {
        if (!this.open.has(id)) this.itemStarted(item, parentKey);
        this.completed(id, itemStatus(item.status), {
          output: String(item.aggregatedOutput ?? ""),
          exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        });
        return;
      }
      case "fileChange": {
        const status = itemStatus(item.status);
        for (const change of this.changes(item)) {
          const key = `${id}:${change.path}`;
          if (!this.open.has(key)) this.fileStarted(id, change, parentKey);
          this.completed(key, status);
        }
        for (const key of this.fileChanges.get(id) ?? [])
          this.completed(key, status);
        this.fileChanges.delete(id);
        return;
      }
      case "mcpToolCall": {
        if (!this.open.has(id)) this.itemStarted(item, parentKey);
        this.mcpCalls.delete(id);
        const error =
          isObject(item.error) && typeof item.error.message === "string"
            ? item.error.message
            : null;
        this.completed(id, itemStatus(item.status), {
          result: isObject(item.result)
            ? {
                content: item.result.content ?? [],
                structuredContent: item.result.structuredContent ?? null,
              }
            : null,
          error,
        });
        return;
      }
      case "dynamicToolCall": {
        if (this.input.hidden?.(String(item.tool ?? ""))) return;
        if (!this.open.has(id)) this.itemStarted(item, parentKey);
        this.completed(
          id,
          item.success === false ? "failed" : itemStatus(item.status),
          { result: item.contentItems ?? null },
        );
        return;
      }
      case "webSearch":
        if (!this.open.has(id)) this.itemStarted(item, parentKey);
        this.completed(id, "completed", {
          input: webSearchInput(item),
          result: Array.isArray(item.results) ? item.results : null,
        });
        return;
      case "collabAgentToolCall": {
        if (item.tool !== "spawnAgent") return;
        if (!this.open.has(id)) this.itemStarted(item, parentKey);
        this.linkChildren(item, id);
        this.completed(
          id,
          item.status === "failed"
            ? "failed"
            : item.status === "interrupted"
              ? "cancelled"
              : "completed",
          { result: subagentResult(item) },
        );
        return;
      }
    }
  }

  agentDelta(itemId: string, delta: string): void {
    if (!this.open.has(itemId)) return;
    this.input.emit({
      type: "item.delta",
      key: itemId,
      field: "text",
      text: delta,
    });
  }

  commandDelta(itemId: string, delta: string): void {
    if (!this.open.has(itemId)) return;
    this.input.emit({
      type: "item.delta",
      key: itemId,
      field: "output",
      text: delta,
    });
  }

  /** A reasoning summary streams; its bold heading is the live status. */
  reasoningDelta(itemId: string, delta: string, part: number): void {
    const state = this.reasoning.get(itemId);
    if (!state) return;
    const text = part !== state.part && state.text ? `\n\n${delta}` : delta;
    state.part = part;
    if (!text) return;
    if (!state.started) {
      state.started = true;
      this.started(
        itemId,
        { kind: "reasoning", text: "" },
        state.parentKey ? { parentKey: state.parentKey } : {},
      );
    }
    state.text += text;
    this.input.emit({ type: "item.delta", key: itemId, field: "text", text });
    this.statusFrom(state.text);
  }

  /** The turn's plan: one item, updated as the agent revises it. */
  plan(turnId: string, steps: JsonValue): void {
    const mapped = Array.isArray(steps)
      ? steps.filter(isObject).map((step) => ({
          text: String(step.step ?? ""),
          status:
            step.status === "completed"
              ? ("completed" as const)
              : step.status === "inProgress"
                ? ("in_progress" as const)
                : ("pending" as const),
        }))
      : [];
    if (!this.planKey) {
      this.planKey = `plan:${turnId}`;
      this.started(
        this.planKey,
        { kind: "plan", steps: mapped },
        { ref: null },
      );
      return;
    }
    this.input.emit({
      type: "item.updated",
      key: this.planKey,
      item: { steps: mapped },
    });
  }

  /** The MCP call a tool approval is about: the latest open one on that server. */
  mcpCall(
    server: string,
  ): { key: string; tool: string; input: JsonValue } | undefined {
    let found: { key: string; tool: string; input: JsonValue } | undefined;
    for (const [key, call] of this.mcpCalls)
      if (call.server === server)
        found = { key, tool: call.tool, input: call.input };
    return found;
  }

  /** Close what is still open when the turn ends. */
  closeOpen(turn: "completed" | "failed" | "interrupted"): void {
    for (const [key, item] of [...this.open]) {
      this.completed(
        key,
        item.kind === "plan" || turn === "completed"
          ? "completed"
          : turn === "interrupted"
            ? "cancelled"
            : "failed",
      );
    }
  }

  private changes(item: JsonObject): FileChangeEntry[] {
    const name = this.input.filePath ?? ((file: string) => file);
    return changesOf(item).map((change) => ({
      ...change,
      path: name(change.path),
      ...(change.movePath ? { movePath: name(change.movePath) } : {}),
    }));
  }

  private fileStarted(
    id: string,
    change: FileChangeEntry,
    parentKey: string | undefined,
  ): void {
    const key = `${id}:${change.path}`;
    const keys = this.fileChanges.get(id) ?? new Set<string>();
    keys.add(key);
    this.fileChanges.set(id, keys);
    this.started(
      key,
      {
        kind: "file_change",
        path: change.movePath ?? change.path,
        change: change.kind,
        previousPath: change.movePath ? change.path : null,
      },
      { parentKey, ref: id },
    );
  }

  private statusFrom(text: string): void {
    const heading = reasoningHeading(text);
    if (!heading || heading === this.status) return;
    this.status = heading;
    this.input.emit({ type: "status", text: heading });
  }

  /**
   * A native subagent's thread started before its spawn reported it: nest
   * it under the latest spawn still open.
   */
  adoptChild(thread: string): void {
    if (this.childThreads.has(thread)) return;
    const spawn = [...this.open]
      .reverse()
      .find(([, item]) => item.kind === "subagent");
    if (spawn) this.childThreads.set(thread, spawn[0]);
  }

  private linkChildren(item: JsonObject, key: string): void {
    if (!Array.isArray(item.receiverThreadIds)) return;
    for (const thread of item.receiverThreadIds)
      if (typeof thread === "string") this.childThreads.set(thread, key);
  }
}

interface FileChangeEntry {
  path: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  movePath?: string;
}

function changesOf(item: JsonObject): FileChangeEntry[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.filter(isObject).flatMap((change): FileChangeEntry[] => {
    if (typeof change.path !== "string") return [];
    const kind = isObject(change.kind) ? change.kind : {};
    if (kind.type === "add") return [{ path: change.path, kind: "created" }];
    if (kind.type === "delete") return [{ path: change.path, kind: "deleted" }];
    return typeof kind.move_path === "string" && kind.move_path
      ? [{ path: change.path, kind: "renamed", movePath: kind.move_path }]
      : [{ path: change.path, kind: "modified" }];
  });
}

function itemStatus(status: JsonValue | undefined): ItemStatus {
  if (status === "failed") return "failed";
  if (status === "declined") return "cancelled";
  return "completed";
}

function webSearchInput(item: JsonObject): JsonValue {
  return {
    query: typeof item.query === "string" ? item.query : "",
    ...(isObject(item.action) ? { action: item.action } : {}),
  };
}

function subagentTitle(prompt: JsonValue | undefined): string {
  const line = typeof prompt === "string" ? prompt.trim().split("\n")[0] : "";
  if (!line) return "Subagent";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function subagentResult(item: JsonObject): string | null {
  if (!isObject(item.agentsStates)) return null;
  const messages = Object.values(item.agentsStates)
    .filter(isObject)
    .map((state) => (typeof state.message === "string" ? state.message : ""))
    .filter(Boolean);
  return messages.length > 0 ? messages.join("\n\n") : null;
}

/** A tool call's own `description` argument, when the agent wrote one. */
function describedBy(input: JsonValue): string | null {
  return isObject(input) &&
    typeof input.description === "string" &&
    input.description
    ? input.description
    : null;
}
