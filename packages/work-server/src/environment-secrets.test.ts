import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter } from "@catamorphic/agent-protocol/runner";
import {
  type Identity,
  projectPrincipalIdentity,
  type RegisteredCodingAgent,
} from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type {
  EnvironmentRuntimeBinding,
  SandboxProvider,
} from "@catamorphic/sandbox";
import {
  createCatamorphic,
  defineStaticEnvironments,
  FsBackend,
  ProjectManager,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { expect, it } from "vitest";
import { replyOf } from "./test-support.js";

/*
 * Project secrets in Environments, end to end (ADR 0205): a member's own
 * value reaches their own chat's sandbox on an isolating machine when they
 * wrote the turn's input, and the recorded reply never holds it; another
 * person's turn, a machine that isolates no one, and the project's chats
 * get what the ADR says, with the agent told what is missing.
 */

const OWN = "own-clickhouse-0123456789";
const SHARED = "shared-clickhouse-9876543210";

/**
 * A host harness that reports what its commands see: the secret, after
 * loading the session's secrets file as every built-in shell command does,
 * streamed in two halves, then the notes Work gave it.
 */
const agent: RegisteredCodingAgent = {
  id: "secrets-agent",
  topology: "controller",
  harness: { placement: "host", adapter: secretsAdapter() },
};

function secretsAdapter(): HarnessAdapter {
  return {
    id: "secrets-agent",
    capabilities: () => ({
      steer: false,
      interrupt: true,
      retry: false,
      fork: false,
      rollback: false,
      questions: false,
      approvals: false,
      elicitations: false,
      subagents: false,
      streamsText: true,
      streamsReasoning: false,
      nativeState: "none",
      ids: { thread: "strong", turn: "none", item: "none" },
    }),
    start: (attempt, host, local) => {
      const run = async () => {
        host.emit({
          type: "thread",
          ref: { id: attempt.sessionId, strength: "strong" },
        });
        const sandbox = local?.sandbox;
        if (!isSandbox(sandbox)) throw new Error("Missing the sandbox");
        const file = sandbox.envFile ?? "";
        const result = await sandbox.provider.executeCommand(
          sandbox.sandboxId,
          `if [ -f '${file}' ]; then . '${file}'; fi; printf '%s' "\${CLICKHOUSE_API_KEY:-unset}"`,
          { cwd: sandbox.workingDirectory },
        );
        const seen = result.result;
        const half = Math.ceil(seen.length / 2);
        host.emit({
          type: "item.started",
          key: "reply",
          item: { kind: "assistant_message", text: "", agentId: null },
        });
        for (const text of [`Key: ${seen.slice(0, half)}`, seen.slice(half)])
          host.emit({ type: "item.delta", key: "reply", field: "text", text });
        host.emit({
          type: "item.delta",
          key: "reply",
          field: "text",
          text: `\n---\n${attempt.input?.text ?? ""}`,
        });
        host.emit({
          type: "item.completed",
          key: "reply",
          status: "completed",
        });
        host.emit({ type: "turn.completed", status: "completed" });
      };
      const finished = run().catch((error: unknown) =>
        host.emit({
          type: "turn.completed",
          status: "failed",
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      return { steer: async () => false, interrupt: () => {}, finished };
    },
  };
}

function isSandbox(value: unknown): value is {
  provider: Pick<SandboxProvider, "executeCommand">;
  sandboxId: string;
  workingDirectory: string;
  envFile?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    "sandboxId" in value &&
    typeof value.sandboxId === "string" &&
    "workingDirectory" in value &&
    typeof value.workingDirectory === "string"
  );
}

it("delivers a member's own value only to turns they wrote, on machines that isolate them, and never records it", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-secrets-"),
  );
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite({ extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  const roots = {
    isolated: path.join(directory, "isolated"),
    shared: path.join(directory, "shared"),
  };
  const runtimes: EnvironmentRuntimeBinding[] = (
    ["isolated", "shared"] as const
  ).map((machine) => ({
    descriptor: {
      id: machine,
      label: machine,
      trust: "managed",
      // Stands in for a VM or gVisor sandbox beside a machine of plain
      // processes several people share.
      isolation: machine === "isolated" ? "sandbox" : "process",
      workloads: ["agent"],
      agentTopologies: ["controller"],
      capabilities: [],
      resources: {},
      labels: { machine },
    },
    sandboxProvider: new LocalProcessSandboxProvider({ root: roots[machine] }),
  }));
  const cat = createCatamorphic({
    hostId: "secrets-host",
    database: { db },
    storage: {
      projectManager: new ProjectManager(
        new FsBackend(path.join(directory, "projects")),
      ),
    },
    environmentProvider: defineStaticEnvironments(runtimes),
    codingAgent: agent,
    projectSeeds: () => ({}),
    standingAgentPrompt: false,
  });
  try {
    await cat.migrate();
    const tenantId = randomUUID();
    const owner: Identity = { tenantId, externalUserId: "member" };
    const admin: Identity = { tenantId, externalUserId: "admin" };
    const project = await cat.core.projects.create(owner, { name: "Secrets" });
    const repo = await cat.core.projectManager.open(tenantId, project.id);
    await repo.writeFile(
      ".work/project.json",
      JSON.stringify({
        secrets: {
          CLICKHOUSE_API_KEY: { description: "Your ClickHouse key" },
        },
        environments: {
          isolated: {
            pool: { machine: "isolated" },
            workloads: ["agent"],
            secrets: ["CLICKHOUSE_API_KEY", "STRIPE_KEY"],
          },
          shared: {
            pool: { machine: "shared" },
            workloads: ["agent"],
            secrets: ["CLICKHOUSE_API_KEY"],
          },
        },
        defaultEnvironment: "isolated",
      }),
    );
    await repo.commit("Configure secrets", {
      name: "Member",
      email: "member@example.test",
    });
    await repo.dispose();
    const secrets = cat.core.secrets;
    const sessions = cat.core.agentSessions;
    if (!secrets || !sessions) throw new Error("Secrets and chats expected");
    await secrets.upsert({
      identity: admin,
      projectId: project.id,
      name: "CLICKHOUSE_API_KEY",
      value: SHARED,
    });
    await secrets.setMember({
      identity: owner,
      projectId: project.id,
      name: "CLICKHOUSE_API_KEY",
      member: "member",
      value: OWN,
    });

    // The owner's own turn on an isolating machine: their own value.
    const chat = await sessions.create(owner, project.id, {
      environment: "isolated",
    });
    const own = replyOf(
      await sessions.sendMessage(owner, project.id, chat.id, "Which key?"),
    );
    expect(own.turn.status).toBe("completed");
    expect(own.content).toContain("Key: [secret CLICKHOUSE_API_KEY]");
    expect(own.content).not.toContain("own-clickhouse");
    // The agent hears what it did not get, and why.
    expect(own.content).toContain("Environment 'isolated' lists STRIPE_KEY");
    const [sandboxId] = await fs.readdir(roots.isolated);
    const file = path.join(
      roots.isolated,
      sandboxId ?? "",
      "workspace",
      ".work-session",
      "env",
      "secrets.sh",
    );
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, "utf8")).toContain(OWN);
    // Nothing recorded holds the value, the log's events included.
    const recorded = JSON.stringify([
      await db.selectFrom("agent_items").selectAll().execute(),
      await db.selectFrom("agent_session_events").selectAll().execute(),
      await db.selectFrom("connection_audit_events").selectAll().execute(),
    ]);
    expect(recorded).not.toContain("own-clickhouse");
    expect(recorded).toContain("project_secrets.deliver");

    // Someone else writes in the owner's chat: the file leaves first.
    const other = replyOf(
      await sessions.sendMessage(admin, project.id, chat.id, "And now?"),
    );
    expect(other.content).toContain("Key: unset");
    expect(other.content).toContain(
      "Work sets them only for turns that answer the chat owner's own messages",
    );
    await expect(fs.stat(file)).rejects.toThrow();

    // A machine that runs other people's work as plain processes.
    const onShared = await sessions.create(owner, project.id, {
      environment: "shared",
    });
    const shared = replyOf(
      await sessions.sendMessage(owner, project.id, onShared.id, "Here?"),
    );
    expect(shared.content).toContain("Key: unset");
    expect(shared.content).toContain(
      "also runs other people's work as plain processes",
    );

    // The project's own chat on an isolating machine: the shared value.
    const projectIdentity = projectPrincipalIdentity({
      tenantId,
      projectId: project.id,
      environment: "isolated",
    });
    const projectChat = await sessions.create(projectIdentity, project.id, {
      environment: "isolated",
    });
    const forProject = replyOf(
      await sessions.sendMessage(
        projectIdentity,
        project.id,
        projectChat.id,
        "Project key?",
      ),
    );
    expect(forProject.content).toContain("Key: [secret CLICKHOUSE_API_KEY]");
    expect(
      JSON.stringify(await db.selectFrom("agent_items").selectAll().execute()),
    ).not.toContain("shared-clickhouse");
  } finally {
    await cat.close();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 120_000);
