import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pendingRequests,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import type { HarnessAdapter } from "@catamorphic/agent-protocol/runner";
import {
  type Identity,
  MemoryCredentialVault,
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
const ROTATED = "rotated-clickhouse-5555555555";

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
        const prelude = (sandbox.envFiles ?? [])
          .map((file) => `if [ -f '${file}' ]; then . '${file}'; fi; `)
          .join("");
        const result = await sandbox.provider.executeCommand(
          sandbox.sandboxId,
          `${prelude}printf '%s' "\${CLICKHOUSE_API_KEY:-unset}"`,
          { cwd: sandbox.workingDirectory },
        );
        const seen = result.result;
        // `[[ask]]` waits for the person's answer first.
        if (attempt.input?.text.includes("[[ask]]"))
          await host.request("ask", {
            kind: "question",
            blocking: true,
            title: "Which key?",
            origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
            questions: [
              {
                question: "Which key?",
                header: "Key",
                multiSelect: false,
                options: [],
              },
            ],
          });
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

/** Poll until `read` gives something, within a deadline. */
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isSandbox(value: unknown): value is {
  provider: Pick<SandboxProvider, "executeCommand">;
  sandboxId: string;
  workingDirectory: string;
  envFiles?: readonly string[];
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
    credentialVault: new MemoryCredentialVault(),
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

    // A question in a turn that holds the owner's value is the owner's to
    // answer, and the refusal says why.
    await sessions.command(owner, project.id, chat.id, {
      type: "send",
      commandId: randomUUID(),
      text: "[[ask]] Which one?",
    });
    const question = await waitFor(async () => {
      const state = sessionStateFromSnapshot(
        (await sessions.get(owner, project.id, chat.id)).snapshot,
      );
      return pendingRequests(state)[0];
    });
    const refused = await sessions.command(admin, project.id, chat.id, {
      type: "respond",
      commandId: randomUUID(),
      requestId: question.id,
      response: { kind: "question", answers: ["Mine"] },
    });
    expect(refused).toMatchObject({
      status: "rejected",
      error: {
        code: "owner_only",
        message:
          "This turn has its owner's own secrets or files, so only they can answer it.",
      },
    });
    await sessions.command(owner, project.id, chat.id, {
      type: "respond",
      commandId: randomUUID(),
      requestId: question.id,
      response: { kind: "question", answers: ["Mine"] },
    });
    await waitFor(async () => {
      const state = sessionStateFromSnapshot(
        (await sessions.get(owner, project.id, chat.id)).snapshot,
      );
      return Object.values(state.turns).every(
        (turn) => turn.status === "completed",
      )
        ? true
        : undefined;
    });

    // Someone else writes in the owner's chat: the file leaves first.
    const other = replyOf(
      await sessions.sendMessage(admin, project.id, chat.id, "And now?"),
    );
    expect(other.content).toContain("Key: unset");
    expect(other.content).toContain(
      "Work sets them only for turns that answer the chat owner's own messages",
    );
    await expect(fs.stat(file)).rejects.toThrow();

    // The chat held the owner's value: whoever writes next, its agent can
    // repeat it from its transcript, files or processes, so every turn of
    // it masks every value it could hold.
    const repeat = (value: string) => `Repeat after me: ${value}`;
    const replyItems = async (sessionId: string) =>
      JSON.stringify(
        await db
          .selectFrom("agent_items")
          .select("payload")
          .where("session_id", "=", sessionId)
          .where("kind", "=", "assistant_message")
          .execute(),
      );
    const echoed = replyOf(
      await sessions.sendMessage(admin, project.id, chat.id, repeat(OWN)),
    );
    expect(echoed.content).toContain(
      "Repeat after me: [secret CLICKHOUSE_API_KEY]",
    );
    expect(await replyItems(chat.id)).not.toContain("own-clickhouse");

    // A fork carries the transcript: a teammate's fork masks the source
    // owner's value too.
    const fork = await sessions.fork(admin, project.id, chat.id);
    const inFork = replyOf(
      await sessions.sendMessage(admin, project.id, fork.id, repeat(OWN)),
    );
    expect(inFork.content).toContain(
      "Repeat after me: [secret CLICKHOUSE_API_KEY]",
    );
    expect(await replyItems(fork.id)).not.toContain("own-clickhouse");

    // Rotated: the old value, delivered before, stays masked.
    await secrets.setMember({
      identity: owner,
      projectId: project.id,
      name: "CLICKHOUSE_API_KEY",
      member: "member",
      value: ROTATED,
    });
    const rotated = replyOf(
      await sessions.sendMessage(owner, project.id, chat.id, repeat(OWN)),
    );
    expect(rotated.content).toContain("Key: [secret CLICKHOUSE_API_KEY]\n---");
    expect(rotated.content).toContain(
      "Repeat after me: [secret CLICKHOUSE_API_KEY]",
    );
    expect(await replyItems(chat.id)).not.toContain("own-clickhouse");
    expect(await replyItems(chat.id)).not.toContain("rotated-clickhouse");

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

    // A person opens a new chat's workspace (a terminal): the owner's
    // value arrives without a turn. The project then stops listing it, and
    // a teammate's turn finds the file gone.
    const opened = await sessions.create(owner, project.id, {
      environment: "isolated",
    });
    const workspace = await sessions.personWorkspace({
      identity: owner,
      projectId: project.id,
      sessionId: opened.id,
      start: true,
    });
    const openedFile = path.join(
      roots.isolated,
      workspace.sandboxId,
      "workspace",
      ".work-session",
      "env",
      "secrets.sh",
    );
    expect(await fs.readFile(openedFile, "utf8")).toContain(ROTATED);
    const unlisted = await cat.core.projectManager.open(tenantId, project.id);
    await unlisted.writeFile(
      ".work/project.json",
      JSON.stringify({
        secrets: {
          CLICKHOUSE_API_KEY: { description: "Your ClickHouse key" },
        },
        environments: {
          isolated: { pool: { machine: "isolated" }, workloads: ["agent"] },
          shared: { pool: { machine: "shared" }, workloads: ["agent"] },
        },
        defaultEnvironment: "isolated",
      }),
    );
    await unlisted.commit("Stop listing the key", {
      name: "Member",
      email: "member@example.test",
    });
    await unlisted.dispose();
    const after = replyOf(
      await sessions.sendMessage(admin, project.id, opened.id, repeat(ROTATED)),
    );
    expect(after.content).toContain("Key: unset");
    expect(after.content).toContain(
      "Repeat after me: [secret CLICKHOUSE_API_KEY]",
    );
    await expect(fs.stat(openedFile)).rejects.toThrow();
  } finally {
    await cat.close();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("masks every value the workspace held in what setup hands a teammate's turn", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-secrets-setup-"),
  );
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite({ extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  const cat = createCatamorphic({
    hostId: "secrets-setup-host",
    database: { db },
    storage: {
      projectManager: new ProjectManager(
        new FsBackend(path.join(directory, "projects")),
      ),
    },
    environmentProvider: defineStaticEnvironments([
      {
        descriptor: {
          id: "isolated",
          label: "isolated",
          trust: "managed",
          isolation: "sandbox",
          workloads: ["agent"],
          agentTopologies: ["controller"],
          capabilities: [],
          resources: {},
        },
        sandboxProvider: new LocalProcessSandboxProvider({
          root: path.join(directory, "machine"),
        }),
      },
    ]),
    codingAgent: agent,
    credentialVault: new MemoryCredentialVault(),
    projectSeeds: () => ({}),
    standingAgentPrompt: false,
  });
  try {
    await cat.migrate();
    const tenantId = randomUUID();
    const owner: Identity = { tenantId, externalUserId: "member" };
    const admin: Identity = { tenantId, externalUserId: "admin" };
    const project = await cat.core.projects.create(owner, { name: "Setup" });
    const repo = await cat.core.projectManager.open(tenantId, project.id);
    // Setup prints the key and fails, so it runs again before every turn,
    // appending to the same log.
    await repo.writeFile(
      ".work/project.json",
      JSON.stringify({
        secrets: { CLICKHOUSE_API_KEY: {} },
        environments: {
          dev: {
            workloads: ["agent"],
            secrets: ["CLICKHOUSE_API_KEY"],
            setup: `printf 'setup saw %s\\n' "$CLICKHOUSE_API_KEY"; exit 3`,
          },
        },
        defaultEnvironment: "dev",
      }),
    );
    await repo.commit("Configure setup", {
      name: "Member",
      email: "member@example.test",
    });
    await repo.dispose();
    const secrets = cat.core.secrets;
    const sessions = cat.core.agentSessions;
    if (!secrets || !sessions) throw new Error("Secrets and chats expected");
    await secrets.setMember({
      identity: owner,
      projectId: project.id,
      name: "CLICKHOUSE_API_KEY",
      member: "member",
      value: OWN,
    });
    const chat = await sessions.create(owner, project.id);
    const first = replyOf(
      await sessions.sendMessage(owner, project.id, chat.id, "Go"),
    );
    expect(first.content).toContain("setup saw [secret CLICKHOUSE_API_KEY]");
    // The teammate's turn has no secrets, and its setup log's tail still
    // shows the owner's earlier run.
    const second = replyOf(
      await sessions.sendMessage(admin, project.id, chat.id, "Go on"),
    );
    expect(second.content).toContain("Key: unset");
    expect(second.content).toContain("setup saw [secret CLICKHOUSE_API_KEY]");
    expect(
      JSON.stringify(await db.selectFrom("agent_items").selectAll().execute()),
    ).not.toContain("own-clickhouse");
  } finally {
    await cat.close();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 120_000);
