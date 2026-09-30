import {
  type Identity,
  type Project,
  type RemoteSyncOutcome,
  renewReplicaClaim,
  takeReplicaClaim,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";

/** How often each company project receives its code host's changes. */
export const PROJECT_SYNC_SECONDS = 60;

/** What the company project sync reads and runs. */
export interface CompanyProjectSyncServices {
  db: Kysely<DB>;
  projects: {
    list(
      identity: Identity,
      input: { limit: number; offset: number },
    ): Promise<{
      items: Array<Pick<Project, "id" | "remoteUrl" | "remoteDivergedAt">>;
      total: number;
    }>;
  };
  remoteSync: {
    syncPublished(input: {
      identity: Identity;
      projectId: string;
    }): Promise<RemoteSyncOutcome>;
  };
}

/**
 * One pass over the company projects attached to a code host: each receives
 * what its default branch accepts, through the organization's service
 * connection. Every replica runs passes; the claim per project is the
 * schedule, so one replica syncs each project a minute (ADR 0193).
 */
export async function syncCompanyProjects(input: {
  services: CompanyProjectSyncServices;
  identity: Identity;
  /** This process, as the holder of the claims it takes. */
  holder: string;
  stopped?: () => boolean;
  /** How often each project syncs (default {@link PROJECT_SYNC_SECONDS}). */
  intervalSeconds?: number;
}): Promise<void> {
  const { services, identity } = input;
  const interval = input.intervalSeconds ?? PROJECT_SYNC_SECONDS;
  for (let offset = 0; !input.stopped?.(); offset += 50) {
    const page = await services.projects.list(identity, {
      limit: 50,
      offset,
    });
    for (const project of page.items) {
      if (input.stopped?.()) return;
      if (!project.remoteUrl) continue;
      try {
        if (
          !(await takeReplicaClaim({
            db: services.db,
            name: `project-sync:${project.id}`,
            holder: input.holder,
            ttlSeconds: interval,
          }))
        )
          continue;
        // A long sync keeps its claim, so no other replica starts the same
        // project meanwhile; the minute counts from when it ends.
        const renewal = setInterval(
          () =>
            void renewReplicaClaim({
              db: services.db,
              name: `project-sync:${project.id}`,
              holder: input.holder,
              ttlSeconds: interval,
            }).catch(() => {}),
          (interval * 1_000) / 4,
        );
        renewal.unref();
        const result = await services.remoteSync
          .syncPublished({ identity, projectId: project.id })
          .finally(() => clearInterval(renewal));
        if (result.status === "pulled" || result.status === "merged") {
          console.info(
            `Company project ${project.id} received published updates`,
          );
        }
        // Accepted changes (a merged roles pull request, say) stop arriving
        // until someone reconciles the two histories. Said once, when it
        // starts; the project carries it as remoteDivergedAt.
        if (result.status === "diverged" && !project.remoteDivergedAt)
          console.warn(
            `Company project ${project.id} no longer receives updates from ${project.remoteUrl}: its main (${result.localSha?.slice(0, 12)}) has diverged from the code host's (${result.remoteSha?.slice(0, 12)}). Share its own changes as a pull request and reconcile the two.`,
          );
      } catch (error) {
        console.warn(`Company project sync failed for ${project.id}:`, error);
      }
    }
    if (offset + page.items.length >= page.total) return;
  }
}

/** Run {@link syncCompanyProjects} now and each minute until stopped. */
export function startCompanyProjectSync(input: {
  services: CompanyProjectSyncServices;
  identity: Identity;
  holder: string;
}): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (active || stopped) return;
    active = syncCompanyProjects({ ...input, stopped: () => stopped })
      .catch((error) => console.warn("Company project sync failed:", error))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, PROJECT_SYNC_SECONDS * 1_000);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
