import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeAdapter,
} from "@catamorphic/claude-code";
import {
  type ClaudeReplayAttempt,
  pinnedClaudeExecutable,
  recordingQuery,
  scriptedModelEnv,
  startScriptedModel,
} from "@catamorphic/claude-code/testing";
import type { Identity, RegisteredCodingAgent } from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import {
  type Catamorphic,
  createCatamorphic,
  defineStaticEnvironments,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { desktopAdapter } from "./harness-adapters.js";

/*
 * The pinned Claude Code CLI on the desktop's host placement, against a
 * scripted loopback model: a settled turn has stored every transcript line
 * the CLI wrote, those it flushes after its result included (ADR 0198), so
 * the chat resumes on any machine.
 */

const identity: Identity = {
  tenantId: "00000000-0000-4000-8000-0000000000c1",
  externalUserId: "desktop-user",
};

let root = "";
let home = "";
let db: Kysely<DB>;
let cat: Catamorphic;
let model: Awaited<ReturnType<typeof startScriptedModel>>;
const recorded: ClaudeReplayAttempt[] = [];

beforeAll(async () => {
  const command = pinnedClaudeExecutable();
  if (!command)
    throw new Error("The pinned Agent SDK ships no Claude Code CLI");
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-native-state-")),
  );
  home = path.join(root, "claude-home");
  await fs.mkdir(home, { recursive: true });
  model = await startScriptedModel({
    reply: () => ({
      blocks: [{ type: "text", text: "Hello from the scripted model." }],
    }),
  });
  const inner = createClaudeCodeAdapter({
    query: recordingQuery({ attempts: recorded }),
  });
  const agent: RegisteredCodingAgent = {
    id: "claude-code",
    name: "Claude Code",
    harness: {
      placement: "host",
      // As the desktop wraps it: the pinned executable, here pointed at
      // the scripted model.
      adapter: desktopAdapter({
        id: "claude-code",
        capabilities: () => CLAUDE_CODE_CAPABILITIES,
        prepare: async (attempt) => ({
          adapter: inner,
          attempt: {
            ...attempt,
            env: {
              ...attempt.env,
              ...scriptedModelEnv({ url: model.url, home }),
            },
            options: { ...attempt.options, command },
          },
        }),
      }),
    },
    topology: "native",
    options: { memory: false },
  };
  const pglite = new PGlite({ extensions: { pgcrypto } });
  db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  cat = createCatamorphic({
    hostId: "claude-native-state",
    database: { db },
    storage: {
      projectsPath: path.join(root, "projects"),
      remotesPath: path.join(root, "remotes"),
    },
    projectSeeds: () => ({}),
    environmentProvider: defineStaticEnvironments([
      {
        descriptor: {
          id: "local",
          label: "This Mac",
          trust: "local",
          isolation: "process",
          workloads: ["agent"],
          agentTopologies: ["native"],
          capabilities: [],
          resources: {},
        },
      },
    ]),
    codingAgent: {
      defaultAgentId: () => agent.id,
      get: (id) => (id === agent.id ? agent : undefined),
      list: () => [agent],
    },
    nativeAgentCheckout: {
      resolve: async ({ sessionId }) => {
        const checkout = path.join(root, "checkouts", sessionId);
        await fs.mkdir(checkout, { recursive: true });
        return { path: checkout, owned: true };
      },
      checkpoint: async () => null,
    },
  });
  await cat.migrate();
}, 120_000);

afterAll(async () => {
  await cat?.core.agentSessions?.stopLocalTurns({ timeoutMs: 5_000 });
  await cat?.close();
  await model?.close();
  await db?.destroy();
  if (root) await fs.rm(root, { recursive: true, force: true });
}, 60_000);

it("stores every transcript line the CLI wrote by the time its turn settles", async () => {
  const project = await cat.core.projects.create(identity, {
    name: "Transcript",
  });
  const sessions = cat.core.agentSessions;
  if (!sessions) throw new Error("This host runs no agent sessions");
  const session = await sessions.create(identity, project.id);
  const { turn, reply } = await sessions.sendMessage(
    identity,
    project.id,
    session.id,
    "Say hello",
  );
  expect(turn.status).toBe("completed");
  expect(reply?.kind === "assistant_message" && reply.text).toBe(
    "Hello from the scripted model.",
  );

  const thread = await db
    .selectFrom("agent_provider_threads")
    .select(["id", "native_ref"])
    .where("session_id", "=", session.id)
    .executeTakeFirstOrThrow();
  const stored = await db
    .selectFrom("agent_provider_thread_entries")
    .select("entry")
    .where("thread_id", "=", thread.id)
    .where("subpath", "=", "")
    .orderBy("seq")
    .execute();
  // The CLI's own transcript, which it finished writing as it exited.
  const ref = thread.native_ref;
  const nativeId =
    ref && typeof ref === "object" && !Array.isArray(ref) ? ref.id : undefined;
  if (typeof nativeId !== "string")
    throw new Error("The thread has no Claude Code session id");
  const projectsDirectory = path.join(home, "projects");
  const files = (
    await fs.readdir(projectsDirectory, { recursive: true })
  ).filter((file) => path.basename(file) === `${nativeId}.jsonl`);
  expect(files).toHaveLength(1);
  const written = (
    await fs.readFile(path.join(projectsDirectory, files[0] ?? ""), "utf8")
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line): unknown => JSON.parse(line));
  expect(written.length).toBeGreaterThan(0);
  expect(stored).toHaveLength(written.length);
  expect(stored.map((row) => row.entry)).toEqual(written);

  // Nothing the CLI stored with Work was refused or timed out.
  const mirrorErrors = recorded.flatMap((attempt) =>
    attempt.messages.filter(
      (message) =>
        message.type === "system" &&
        Reflect.get(message, "subtype") === "mirror_error",
    ),
  );
  expect(mirrorErrors).toEqual([]);
}, 120_000);
