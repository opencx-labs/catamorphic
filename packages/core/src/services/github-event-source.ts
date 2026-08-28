import type { Json } from "@catamorphic/db";
import type { GithubService } from "./github-service.js";
import type {
  ProjectEventMonitor,
  ProjectEventSourceProvider,
} from "./project-event-monitors-service.js";

export class GithubProjectEventSource implements ProjectEventSourceProvider {
  readonly kind = "github";

  constructor(private readonly github: GithubService) {}

  async poll(input: {
    monitor: ProjectEventMonitor;
    identity: { tenantId: string; externalUserId: string };
  }): Promise<{ cursor: Json | null }> {
    const afterExternalId = githubCursor(input.monitor.cursor);
    const result = await this.github.pollProjectEvents(
      input.identity,
      input.monitor.projectId,
      afterExternalId ? { afterExternalId } : {},
    );
    return {
      cursor: result.nextCursor
        ? { externalId: result.nextCursor }
        : input.monitor.cursor,
    };
  }
}

function githubCursor(cursor: Json | null): string | null {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return null;
  }
  return typeof cursor.externalId === "string" ? cursor.externalId : null;
}
