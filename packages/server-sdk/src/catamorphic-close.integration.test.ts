import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { createCatamorphic } from "./catamorphic.js";

const connectionString = process.env.DATABASE_URL ?? "";

/** A harness that works until it is interrupted. */
class QuietAgent implements CodingAgentProvider {
  readonly name = "quiet";
  private markStarted = () => {};
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private markStopped = () => {};
  private readonly stopped = new Promise<void>((resolve) => {
    this.markStopped = resolve;
  });

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(): AsyncIterable<AgentEvent> {
    this.markStarted();
    await this.stopped;
    yield { type: "error", content: "Interrupted." };
    yield { type: "done" };
  }

  interrupt(): void {
    this.markStopped();
  }

  async dispose(): Promise<void> {}
}

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
    const agent = new QuietAgent();
    const registered = {
      id: "quiet",
      provider: agent,
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
      const receipt = await sessions.enqueueMessage(
        identity,
        projectId,
        session.id,
        "work quietly",
      );
      await agent.started;

      await cat.close();

      const turn = await admin.query<{
        status: string;
        lease_owner: string | null;
        metadata: { interrupted?: boolean } | null;
      }>(
        `SELECT t.status, t.lease_owner, m.metadata
           FROM "${schema}".agent_turns t
           LEFT JOIN "${schema}".agent_messages m ON m.id = t.result_message_id
          WHERE t.id = $1`,
        [receipt.turnId],
      );
      expect(turn.rows[0]).toMatchObject({
        status: "failed",
        lease_owner: null,
        metadata: { interrupted: true },
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
