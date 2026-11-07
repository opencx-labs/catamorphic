import type {
  AgentTurnSettledEvent,
  Catamorphic,
  ScopedClient,
} from "@catamorphic/server-sdk";
import { aiToolKind } from "@catamorphic/server-sdk";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./boot.js";
import { terminalIdle } from "./trigger-kinds.js";

export { DESKTOP_TRIGGER_KINDS, terminalIdle } from "./trigger-kinds.js";

/** Tool-kind roster behind the desktop's per-project MCP endpoint. */
export const DESKTOP_MCP_TOOL_KINDS = [aiToolKind];

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
