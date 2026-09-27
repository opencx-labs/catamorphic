import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import {
  AgentSessionsService,
  type NativeCheckout,
} from "../services/agent-sessions-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import { testEnvironmentProvider } from "./test-environment.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await execFileAsync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ])
  ).stdout.trim();

/** A native agent that records what each turn was told. */
class RecordingProvider implements CodingAgentProvider {
  readonly name = "recording";
  readonly told: string[] = [];
  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }
  async *sendMessage(
    _session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    this.told.push(message);
    yield { type: "text", content: "done" };
    yield { type: "done" };
  }
  async dispose(): Promise<void> {}
}

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_workspace_moves";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "mover",
};

describe("workspace moves in native checkouts (ADR 0178)", () => {
  let tmpDir: string;
  let remote: string;
  let featureCommit: string;
  let mainCommit: string;
  let sessions: AgentSessionsService;
  let projects: ProjectsService;
  const provider = new RecordingProvider();
  /** What the host resolves for each session. */
  const checkouts = new Map<
    string,
    (input: { workspace?: { commit: string } }) => Promise<NativeCheckout>
  >();

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-moves-"));
    // The project's linked remote: `main`, and a `feature` branch on it.
    const seed = path.join(tmpDir, "seed");
    await fs.mkdir(seed);
    await git(seed, ["init", "-q", "-b", "main"]);
    await fs.writeFile(path.join(seed, "README.md"), "main\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-q", "-m", "main"]);
    mainCommit = await git(seed, ["rev-parse", "HEAD"]);
    await git(seed, ["checkout", "-q", "-b", "feature"]);
    await fs.writeFile(path.join(seed, "FEATURE.md"), "feature\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-q", "-m", "feature"]);
    featureCommit = await git(seed, ["rev-parse", "HEAD"]);
    await git(seed, ["checkout", "-q", "main"]);
    remote = path.join(tmpDir, "remote.git");
    await execFileAsync("git", ["clone", "-q", "--bare", seed, remote]);

    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const agent = {
      id: "worker",
      provider,
      topology: "native" as const,
    };
    sessions = new AgentSessionsService(db, {
      hostId: "workspace-moves-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      workspaces: new SessionWorkspaces({
        projectManager,
        origin: async () => ({ url: remote, branch: "main" }),
      }),
      nativeAgentCheckout: {
        resolve: (input) => {
          const resolve = checkouts.get(input.sessionId);
          if (!resolve) throw new Error("No checkout for this session");
          return resolve(input);
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** A clone of the remote at main, with uncommitted and untracked work. */
  async function personFolder(name: string): Promise<string> {
    const folder = path.join(tmpDir, name);
    await execFileAsync("git", ["clone", "-q", remote, folder]);
    await fs.writeFile(path.join(folder, "README.md"), "my edit\n");
    await fs.writeFile(path.join(folder, "draft.md"), "not committed\n");
    return folder;
  }

  async function chat(name: string) {
    const project = await projects.create(identity, { name });
    await db
      .updateTable("projects")
      .set({ remote_url: remote, remote_ownership: "attached" })
      .where("id", "=", project.id)
      .execute();
    const session = await sessions.create(identity, project.id);
    return { projectId: project.id, sessionId: session.id };
  }

  async function settled(input: { projectId: string; sessionId: string }) {
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(
          identity,
          input.projectId,
          input.sessionId,
        );
        expect(
          detail.messages.filter(
            (message) =>
              message.role === "assistant" && message.content === "done",
          ),
        ).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
  }

  it("never resets or cleans a person's own folder, and tells the agent", async () => {
    const { projectId, sessionId } = await chat("Own folder");
    const folder = await personFolder("own-folder");
    checkouts.set(sessionId, async () => ({ path: folder, owned: false }));
    await sessions.enqueueMessage(identity, projectId, sessionId, "Review", {
      workspace: { ref: "feature", update: "reset" },
    });
    await settled({ projectId, sessionId });

    expect(await git(folder, ["rev-parse", "HEAD"])).toBe(mainCommit);
    expect(await fs.readFile(path.join(folder, "README.md"), "utf8")).toBe(
      "my edit\n",
    );
    expect(await fs.readFile(path.join(folder, "draft.md"), "utf8")).toBe(
      "not committed\n",
    );
    expect(provider.told.at(-1)).toContain("does not own");
    const row = await db
      .selectFrom("agent_sessions")
      .select(["workspace", "workspace_move"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ workspace: null, workspace_move: null });
  }, 30_000);

  it("gives a chat in the person's folder its own worktree at the new base", async () => {
    const { projectId, sessionId } = await chat("Own worktree");
    const folder = await personFolder("primary-folder");
    const worktree = path.join(tmpDir, "chat-worktree");
    const asked: Array<string | undefined> = [];
    checkouts.set(sessionId, async (input) => {
      asked.push(input.workspace?.commit);
      // The host makes the chat its own checkout at the commit it is given.
      if (input.workspace) {
        await fs.access(worktree).catch(async () => {
          await execFileAsync("git", ["clone", "-q", remote, worktree]);
          await git(worktree, ["checkout", "-q", "--detach", featureCommit]);
        });
        return { path: worktree, owned: true };
      }
      return { path: folder, owned: false };
    });
    await sessions.enqueueMessage(identity, projectId, sessionId, "Review", {
      workspace: { ref: "feature" },
    });
    await settled({ projectId, sessionId });

    expect(asked[0]).toBe(featureCommit);
    expect(await git(worktree, ["rev-parse", "HEAD"])).toBe(featureCommit);
    expect(await git(folder, ["rev-parse", "HEAD"])).toBe(mainCommit);
    expect(await fs.readFile(path.join(folder, "draft.md"), "utf8")).toBe(
      "not committed\n",
    );
    const row = await db
      .selectFrom("agent_sessions")
      .select(["workspace", "workspace_move"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      workspace: { ref: "feature", commit: featureCommit },
      workspace_move: null,
    });
  }, 30_000);

  it("keeps a move delivered while an earlier one was applied", async () => {
    const { projectId, sessionId } = await chat("Second move");
    const worktree = path.join(tmpDir, "second-move");
    await execFileAsync("git", ["clone", "-q", remote, worktree]);
    const later = { ref: "main", commit: mainCommit, update: "rebase" };
    checkouts.set(sessionId, async () => {
      // A delivery arrives while the first move is on its way.
      await db
        .updateTable("agent_sessions")
        .set({ workspace_move: JSON.stringify(later) })
        .where("id", "=", sessionId)
        .execute();
      return { path: worktree, owned: true };
    });
    await sessions.enqueueMessage(identity, projectId, sessionId, "Review", {
      workspace: { ref: "feature" },
    });
    await settled({ projectId, sessionId });
    const row = await db
      .selectFrom("agent_sessions")
      .select(["workspace", "workspace_move"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(row.workspace).toEqual({ ref: "feature", commit: featureCommit });
    expect(row.workspace_move).toEqual(later);
  }, 30_000);
});
