import type {
  AgentTurnSettledEvent,
  Catamorphic,
  ScopedClient,
} from "@catamorphic/server-sdk";
import { defineTriggerKind } from "@catamorphic/server-sdk";
import { z } from "zod";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./boot.js";

/**
 * The desktop app's custom trigger kinds — the embedder side of the trigger
 * contract. A project workflow subscribes with e.g.
 * `triggers: [trigger("chat.turn-completed", { statuses: ["completed"] })]`,
 * and the desktop fires the kind when the real event happens.
 */
export const chatTurnCompleted = defineTriggerKind({
  name: "chat.turn-completed",
  description:
    "A coding-agent chat turn in this project settled (completed, failed, or awaiting input)",
  display: { label: "Chat Turn", icon: "messages-square", color: "#7c3aed" },
  payload: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    status: z.enum(["completed", "failed", "awaiting_input"]),
    changedFiles: z.array(z.string()),
  }),
  config: z.object({
    /** Settled statuses the workflow wants. Omitted = completed only. */
    statuses: z
      .array(z.enum(["completed", "failed", "awaiting_input"]))
      .optional(),
  }),
});

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

export const DESKTOP_TRIGGER_KINDS = [chatTurnCompleted, terminalIdle];

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

  onAgentTurnSettled(event: AgentTurnSettledEvent): void {
    void this.fireChatTurn(event).catch((error) => {
      warn("chat.turn-completed", error);
    });
    // The turn may have created or edited workflows; keep the generated
    // trigger types in the project fresh for the next turn. No-op when
    // nothing drifted.
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
  async syncAllProjectTypes(): Promise<void> {
    const { items } = await this.scoped.projects.list({ limit: 100 });
    await Promise.allSettled(
      items.map((project) =>
        this.scoped.triggers
          .syncTypes({ projectId: project.id })
          .catch((error) => warn(`sync-types ${project.name}`, error)),
      ),
    );
  }

  private async fireChatTurn(event: AgentTurnSettledEvent): Promise<void> {
    const bindings = await this.scoped.triggers.list({
      projectId: event.projectId,
      kind: chatTurnCompleted,
    });
    // Config-driven targeting: each workflow declares which settled
    // statuses it wants; omitted means completed turns only.
    const targets = bindings
      .filter((binding) =>
        (binding.config.statuses ?? ["completed"]).includes(event.status),
      )
      .map((binding) => binding.workflowName);
    if (targets.length === 0) return;
    await this.scoped.triggers.fire({
      projectId: event.projectId,
      kind: chatTurnCompleted,
      payload: {
        sessionId: event.sessionId,
        messageId: event.messageId,
        status: event.status,
        changedFiles: event.changedFiles,
      },
      mode: "async",
      workflows: targets,
    });
  }
}

function warn(source: string, error: unknown): void {
  console.warn(
    `[desktop] trigger ${source} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
