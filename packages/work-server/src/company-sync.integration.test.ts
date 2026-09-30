import { randomUUID } from "node:crypto";
import type { Identity, RemoteSyncOutcome } from "@catamorphic/core";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { expect, it } from "vitest";
import {
  type CompanyProjectSyncServices,
  syncCompanyProjects,
} from "./company-sync.js";
import { createTestDatabase } from "./test-support.js";

const identity: Identity = { tenantId: randomUUID(), externalUserId: "sync" };

/**
 * Two replicas run the company project sync at once (ADR 0193): each
 * project is synced by one of them, and not again until its claim lapses.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "replicas sync each company project once a minute between them",
  async () => {
    const database = await createTestDatabase("work_company_sync");
    const replicas = [
      createDatabase({ connectionString: database.url, poolSize: 4 }),
      createDatabase({ connectionString: database.url, poolSize: 4 }),
    ];
    try {
      const [first, second] = replicas;
      if (!first || !second) throw new Error("No replicas");
      await migrateToLatest({ db: first });
      const projects = Array.from({ length: 12 }, (_, index) => ({
        id: randomUUID(),
        remoteUrl: index === 0 ? null : `https://forge.example.test/${index}`,
        remoteDivergedAt: null,
      }));
      const synced: string[] = [];
      const services = (db: typeof first): CompanyProjectSyncServices => ({
        db,
        projects: {
          list: async (_identity, { limit, offset }) => ({
            items: projects.slice(offset, offset + limit),
            total: projects.length,
          }),
        },
        remoteSync: {
          syncPublished: async ({ projectId }): Promise<RemoteSyncOutcome> => {
            synced.push(projectId);
            // A sync takes a while, so both passes are in flight together.
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { status: "no-remote" };
          },
        },
      });
      const pass = () =>
        Promise.all([
          syncCompanyProjects({
            services: services(first),
            identity,
            holder: "replica-a",
          }),
          syncCompanyProjects({
            services: services(second),
            identity,
            holder: "replica-b",
          }),
        ]);

      await pass();
      const linked = projects.filter((project) => project.remoteUrl);
      expect([...synced].sort()).toEqual(
        linked.map((project) => project.id).sort(),
      );
      // Within the minute, nobody syncs them again.
      await pass();
      expect(synced).toHaveLength(linked.length);
      // Once the minute has passed, each is synced once more.
      await first
        .updateTable("replica_claims")
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .execute();
      await pass();
      expect(synced).toHaveLength(linked.length * 2);
      expect(new Set(synced.slice(linked.length)).size).toBe(linked.length);
    } finally {
      for (const db of replicas) await db.destroy();
      await database.drop();
    }
  },
  60_000,
);
