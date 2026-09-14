import type {
  AgentTurnSettledEvent,
  Catamorphic,
  ScopedClient,
} from "@catamorphic/server-sdk";
import {
  defineTriggerKind,
  GITHUB_PROJECT_EVENT_TRIGGER_KINDS,
  hole,
  mcpToolKind,
  SESSION_TRIGGER_KINDS,
  schedule,
} from "@catamorphic/server-sdk";
import { z } from "zod";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./boot.js";

/** Session events are published durably by core; these sources are desktop-owned. */
export const terminalIdle = defineTriggerKind({
  name: "terminal.idle",
  description:
    "A terminal in this project returned to its prompt after running a command",
  display: { label: "Terminal Idle", icon: "zap", color: "#0e7490" },
  payload: z.object({
    sessionId: z.string(),
    shell: z.string(),
  }),
});

/**
 * Workflows as AI tools (ADR 0042): the whole payload is one hole, so each
 * bound workflow's own input type is the tool's argument schema — frozen
 * per binding at scan time, tool-definition-ready. Served to agents by the
 * per-project MCP endpoint (see {@link DESKTOP_MCP_TOOL_KINDS}).
 */
export const aiToolCall = defineTriggerKind({
  name: "ai.tool-call",
  description:
    "An AI agent calls this workflow as a tool; the workflow input is the tool's argument schema",
  display: { label: "AI Tool", icon: "wrench", color: "#b45309" },
  payload: hole("Args"),
  config: z.strictObject({
    /** The description the model reads when deciding to call the tool. */
    description: z.string().min(1),
    /** Tool name override; defaults to the workflow name. */
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  }),
});

export const DESKTOP_TRIGGER_KINDS = [
  ...SESSION_TRIGGER_KINDS,
  terminalIdle,
  aiToolCall,
  schedule,
  ...GITHUB_PROJECT_EVENT_TRIGGER_KINDS,
];

/** Tool-kind roster behind the desktop's per-project MCP endpoint. */
export const DESKTOP_MCP_TOOL_KINDS = [
  mcpToolKind(aiToolCall, (config) => ({
    description: config.description,
    ...(config.name ? { name: config.name } : {}),
  })),
];

/**
 * Firing helpers bound to the desktop identity. Every entry point is
 * fire-and-forget: trigger delivery must never break the event source
 * (a chat turn, the terminal poll loop).
 */
export class DesktopTriggers {
  private readonly scoped: ScopedClient;

  constructor(catamorphic: Catamorphic) {
    this.scoped = catamorphic
      .forTenant({ tenantId: DESKTOP_TENANT_ID })
      .forUser({ externalUserId: DESKTOP_USER_ID });
  }

  onAgentTurnSettled(event: AgentTurnSettledEvent, refreshTypes = true): void {
    // The turn may have created or edited workflows; keep the generated
    // trigger types in the project fresh for the next turn. No-op when
    // nothing drifted.
    if (refreshTypes)
      void this.scoped.triggers
        .syncTypes({ projectId: event.projectId })
        .catch((error) => warn("sync-types", error));
  }

  onTerminalIdle(
    projectId: string,
    payload: { sessionId: string; shell: string },
  ): void {
    void this.scoped.triggers
      .fire({
        projectId,
        kind: terminalIdle,
        payload,
        mode: "async",
      })
      .catch((error) => warn("terminal.idle", error));
  }

  /** Seed/refresh the generated trigger types across existing projects. */
  async syncAllProjectTypes(
    shouldSync: (projectId: string) => boolean = () => true,
  ): Promise<void> {
    const { items } = await this.scoped.projects.list({ limit: 100 });
    await Promise.allSettled(
      items
        .filter((project) => shouldSync(project.id))
        .map((project) =>
          this.scoped.triggers
            .syncTypes({ projectId: project.id })
            .catch((error) => warn(`sync-types ${project.name}`, error)),
        ),
    );
  }
}

function warn(source: string, error: unknown): void {
  console.warn(
    `[desktop] trigger ${source} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
