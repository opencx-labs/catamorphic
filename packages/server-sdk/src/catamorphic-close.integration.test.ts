import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import { EchoAdapter } from "@catamorphic/agent-runner";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { createCatamorphic } from "./catamorphic.js";

const connectionString = process.env.DATABASE_URL ?? "";

/**
 * Closing an SDK instance that owns its database (ADR 0193): a turn running
 * here is interrupted and settles before the database goes, and nothing
 * (no lease renewal, no drain) reaches the closed database afterwards.
 */
it.skipIf(!connectionString)(
  "close() settles a running turn as interrupted and leaves nothing running",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-close-"));
    const schema = `sdk_close_${crypto.randomUUID().replaceAll("-", "")}`;
    // The echo harness works on `[[hang]]` until it is interrupted.
    const registered = {
      id: "quiet",
      harness: { placement: "host" as const, adapter: new EchoAdapter() },
      topology: "native" as const,
    };
    const warn = vi.spyOn(console, "warn");
    const cat = createCatamorphic({
      hostId: "close-test-host",
      database: { connectionString, schema },
      storage: {
        projectsPath: path.join(root, "projects"),
        remotesPath: path.join(root, "remotes"),
      },
      projectSeeds: () => ({}),
      environmentProvider: {
        get: ({ pool }) =>
          Object.keys(pool).length === 0
            ? {
                descriptor: {
                  id: "local",
                  label: "Development",
                  trust: "local",
                  isolation: "none",
                  workloads: ["agent"],
                  agentTopologies: ["native"],
                  capabilities: [],
                  resources: {},
                },
              }
            : undefined,
      },
      nativeAgentCheckout: {
        resolve: () => ({ path: root, owned: false }),
      },
      codingAgent: {
        defaultAgentId: () => registered.id,
        get: (id) => (id === registered.id ? registered : undefined),
        list: () => [registered],
      },
    });
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await cat.migrate();
      const identity: Identity = {
        tenantId: crypto.randomUUID(),
        externalUserId: "closer",
      };
      const sessions = cat.core.agentSessions;
      if (!sessions) throw new Error("Agent sessions are not configured");
      const { id: projectId } = await cat.core.projects.create(identity, {
        name: "Close",
      });
      const session = await sessions.create(identity, projectId, {});
      await sessions.command(identity, projectId, session.id, {
        type: "send",
        commandId: crypto.randomUUID(),
        text: "[[hang]]",
      });
      await vi.waitFor(
        async () => {
          const detail = await sessions.get(identity, projectId, session.id);
          expect(detail.snapshot.turns[0]?.status).toBe("running");
        },
        { timeout: 15_000 },
      );

      await cat.close();

      const turn = await admin.query<{
        status: string;
        lease_owner: string | null;
      }>(
        `SELECT status, lease_owner FROM "${schema}".agent_turns WHERE session_id = $1`,
        [session.id],
      );
      expect(turn.rows[0]).toMatchObject({
        status: "interrupted",
        lease_owner: null,
      });
      // No lease renewal or drain reaches the closed database.
      warn.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  60_000,
);
