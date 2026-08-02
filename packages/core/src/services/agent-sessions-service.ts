import type { DB, JsonObject } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  AgentEvent,
  AttachedPluginForAgent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
} from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  DURABLE_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
} from "../templates.js";
import { assertProjectSurface } from "./app-audience.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import type { PluginsService } from "./plugins-service.js";
import { ProjectNotFoundError } from "./projects-service.js";

type SessionRow = Selectable<DB["agent_sessions"]>;
type MessageRow = Selectable<DB["agent_messages"]>;

export interface AgentSession {
  id: string;
  projectId: string;
  externalUserId: string;
  provider: string;
  providerSessionId: string | null;
  sandboxId: string | null;
  title: string | null;
  status: "active" | "closed";
  baseCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  commitSha: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentSessionDetail extends AgentSession {
  messages: AgentMessage[];
}

export class AgentSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent session '${sessionId}' not found`);
    this.name = "AgentSessionNotFoundError";
  }
}

export class AgentSessionClosedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent session '${sessionId}' is closed`);
    this.name = "AgentSessionClosedError";
  }
}

export interface SyncedFileChange {
  path: string;
  kind: "modified" | "deleted";
}

const tracer = getTracer("@catamorphic/core");

const WORKFLOW_AUTHORING_SYSTEM_PROMPT = `Before editing workflow code, inspect the existing export and preserve its authoring model unless the user explicitly requests a conversion. A plain workflow is an exported async function with a "use workflow" directive. A defined workflow is an exported defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps })) value; production runs execute ordered boundary and batch scopes against an immutable deployment, with continuation state persisted in Postgres. Mutable-source defined test execution is not supported. Cancellation is a host-issued terminal control declared with controls: { cancel: true }, never a BoundaryContext transition. Only exported defineBatchStep calls inside defineBatch.process are physically coalesced. For authoring primitives, use the project's established SaaS wrapper when present; otherwise use @catamorphic/workflow. Never create local copies. Consult .agents/skills/writing-workflows/SKILL.md, .agents/skills/durable-workflows/SKILL.md, and .agents/skills/batch-workflows/SKILL.md, when present, before creating or restructuring workflows.`;

export function buildAgentSystemPrompt({
  systemPrompt,
}: {
  systemPrompt?: string;
}): string {
  return [WORKFLOW_AUTHORING_SYSTEM_PROMPT, systemPrompt]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export async function ensureBatchWorkflowSkill({
  sandboxProvider,
  sandboxProviderId,
  projectDir,
}: {
  sandboxProvider: Pick<SandboxProvider, "executeCommand" | "uploadFiles">;
  sandboxProviderId: string;
  projectDir: string;
}): Promise<boolean> {
  return ensureWorkflowSkill({
    sandboxProvider,
    sandboxProviderId,
    projectDir,
    skillPath: BATCH_WORKFLOW_SKILL_PATH,
  });
}

export async function ensureDurableWorkflowSkill({
  sandboxProvider,
  sandboxProviderId,
  projectDir,
}: {
  sandboxProvider: Pick<SandboxProvider, "executeCommand" | "uploadFiles">;
  sandboxProviderId: string;
  projectDir: string;
}): Promise<boolean> {
  return ensureWorkflowSkill({
    sandboxProvider,
    sandboxProviderId,
    projectDir,
    skillPath: DURABLE_WORKFLOW_SKILL_PATH,
  });
}

async function ensureWorkflowSkill({
  sandboxProvider,
  sandboxProviderId,
  projectDir,
  skillPath,
}: {
  sandboxProvider: Pick<SandboxProvider, "executeCommand" | "uploadFiles">;
  sandboxProviderId: string;
  projectDir: string;
  skillPath: string;
}): Promise<boolean> {
  const content = SEED_SKILLS[skillPath];
  if (!content) {
    throw new Error(`Built-in workflow skill '${skillPath}' is not configured`);
  }

  const absoluteSkillPath = `${projectDir}/${skillPath}`;
  const exists = await sandboxProvider.executeCommand(
    sandboxProviderId,
    `test -f ${shellQuote(absoluteSkillPath)}`,
  );
  if (exists.exitCode === 0) return false;
  if (exists.exitCode !== 1) {
    throw new Error(`Failed to inspect workflow skill: ${exists.result}`);
  }

  await sandboxProvider.uploadFiles(
    sandboxProviderId,
    { [skillPath]: content },
    projectDir,
  );
  return true;
}

/** Files the agent stages for its own use — never synced back to the repo. */
const SYNC_IGNORED_PREFIXES = ["_plugins/", "node_modules/", ".git/"];

interface AgentSessionsDeps {
  projectManager: ProjectManager;
  sandboxProvider: SandboxProvider;
  codingAgent: CodingAgentProvider;
  devSandboxes: DevSandboxService;
  plugins?: PluginsService;
  pluginResolver?: PluginResolver;
}

/**
 * Orchestrates coding-agent sessions:
 *
 * 1. Ensures a per-(project, user) **dev sandbox** exists and contains the
 *    user's current working-copy state (cloned from the project origin when
 *    it is in sync, uploaded otherwise).
 * 2. Starts a session with the pluggable {@link CodingAgentProvider} pointed
 *    at the sandbox project directory.
 * 3. Persists the conversation to `agent_sessions` / `agent_messages`.
 * 4. After each assistant turn, syncs files the agent changed inside the
 *    sandbox back into the user's dev working copy as an uncommitted draft —
 *    the user reviews and deploys through the normal git flow.
 */
export class AgentSessionsService {
  private readonly projectManager: ProjectManager;
  private readonly sandboxProvider: SandboxProvider;
  private readonly codingAgent: CodingAgentProvider;
  private readonly plugins?: PluginsService;
  private readonly pluginResolver?: PluginResolver;
  private readonly devSandboxes: DevSandboxService;

  constructor(
    private readonly db: Kysely<DB>,
    deps: AgentSessionsDeps,
  ) {
    this.projectManager = deps.projectManager;
    this.sandboxProvider = deps.sandboxProvider;
    this.codingAgent = deps.codingAgent;
    this.devSandboxes = deps.devSandboxes;
    this.plugins = deps.plugins;
    this.pluginResolver = deps.pluginResolver;
  }

  get providerName(): string {
    return this.codingAgent.name;
  }

  async list(
    identity: Identity,
    projectId: string,
    input: { limit?: number; offset?: number } = {},
  ): Promise<{ items: AgentSession[]; total: number }> {
    await this.requireProject(identity, projectId);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const rows = await this.db
      .selectFrom("agent_sessions")
      .where("project_id", "=", projectId)
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    const total = await this.db
      .selectFrom("agent_sessions")
      .where("project_id", "=", projectId)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.count));

    return { items: rows.map(mapSession), total };
  }

  async get(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<AgentSessionDetail> {
    const row = await this.requireSession(identity, projectId, sessionId);
    const messages = await this.db
      .selectFrom("agent_messages")
      .where("session_id", "=", sessionId)
      .selectAll()
      .orderBy("seq", "asc")
      .execute();
    return { ...mapSession(row), messages: messages.map(mapMessage) };
  }

  async create(
    identity: Identity,
    projectId: string,
    input: { systemPrompt?: string } = {},
  ): Promise<AgentSession> {
    return withSpan(
      {
        tracer,
        name: "agent.session.create",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.tenant.id": identity.tenantId,
          "catamorphic.agent.provider": this.codingAgent.name,
        },
      },
      () => this.createInner(identity, projectId, input),
    );
  }

  private async createInner(
    identity: Identity,
    projectId: string,
    input: { systemPrompt?: string },
  ): Promise<AgentSession> {
    await this.requireProject(identity, projectId);

    const { handle, baseCommitSha } = await this.prepareDevSandbox(
      identity,
      projectId,
    );

    const workingDirectory = this.projectDir();
    const attachedPlugins = await this.loadAttachedPlugins(projectId);

    const providerSession = await this.codingAgent.startSession({
      projectId,
      userId: identity.externalUserId,
      sandboxId: handle.providerId,
      workingDirectory,
      systemPrompt: buildAgentSystemPrompt({
        systemPrompt: input.systemPrompt,
      }),
      attachedPlugins,
    });

    const row = await this.db
      .insertInto("agent_sessions")
      .values({
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: this.codingAgent.name,
        provider_session_id: providerSession.providerSessionId,
        sandbox_id: handle.id,
        status: "active",
        base_commit_sha: baseCommitSha,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapSession(row);
  }

  async sendMessage(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
  ): Promise<AgentMessage> {
    return withSpan(
      {
        tracer,
        name: "agent.session.message",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.agent.session.id": sessionId,
          "catamorphic.agent.provider": this.codingAgent.name,
        },
      },
      () => this.sendMessageInner(identity, projectId, sessionId, message),
    );
  }

  private async sendMessageInner(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
  ): Promise<AgentMessage> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }

    const sandboxProviderId = await this.resolveSandboxProviderId(session);
    const workingDirectory = this.projectDir();
    const batchSkillStaged = await ensureBatchWorkflowSkill({
      sandboxProvider: this.sandboxProvider,
      sandboxProviderId,
      projectDir: workingDirectory,
    });
    const durableSkillStaged = await ensureDurableWorkflowSkill({
      sandboxProvider: this.sandboxProvider,
      sandboxProviderId,
      projectDir: workingDirectory,
    });
    const stagedSkillPaths = [
      ...(batchSkillStaged ? [BATCH_WORKFLOW_SKILL_PATH] : []),
      ...(durableSkillStaged ? [DURABLE_WORKFLOW_SKILL_PATH] : []),
    ];
    if (stagedSkillPaths.length > 0) {
      await this.commitWorkflowSkillBaseline(
        sandboxProviderId,
        stagedSkillPaths,
      );
    }

    let assistantMessageId = await this.db
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto("agent_messages")
          .values({
            session_id: sessionId,
            role: "user",
            content: message,
          })
          .execute();
        const assistant = await trx
          .insertInto("agent_messages")
          .values({
            session_id: sessionId,
            role: "assistant",
            content: "Thinking...",
            metadata: progressMetadata([]),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return assistant.id;
      });

    const providerSession: ProviderSession = {
      providerSessionId: session.provider_session_id ?? "",
      sandboxId: sandboxProviderId,
      workingDirectory,
    };

    const events: AgentEvent[] = [];
    // Events since the last flushed preamble — each assistant message keeps
    // only its own segment's events.
    let segmentEvents: AgentEvent[] = [];
    // The provider yields text at tool-call boundaries (preambles) and once
    // at the end (the answer). A segment is held until we know which it is:
    // more work following it makes it a preamble, pushed immediately as its
    // own completed message with a fresh in-progress placeholder after it.
    let heldText: string | undefined;
    let lastFlushed: { id: string; events: AgentEvent[] } | undefined;
    const flushHeldText = async () => {
      if (heldText === undefined) return;
      const metadata: JsonObject = {
        status: "completed",
        events: JSON.parse(JSON.stringify(segmentEvents)) as JsonObject[],
      };
      await this.db
        .updateTable("agent_messages")
        .set({ content: heldText, metadata })
        .where("id", "=", assistantMessageId)
        .execute();
      lastFlushed = { id: assistantMessageId, events: segmentEvents };
      heldText = undefined;
      segmentEvents = [];
      const next = await this.db
        .insertInto("agent_messages")
        .values({
          session_id: sessionId,
          role: "assistant",
          content: "Thinking...",
          metadata: progressMetadata([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      assistantMessageId = next.id;
    };
    const continuesTurn = (event: AgentEvent): boolean =>
      event.type === "text" ||
      event.type === "tool_call" ||
      event.type === "command" ||
      event.type === "file_edit";

    try {
      for await (const event of this.codingAgent.sendMessage(
        providerSession,
        message,
      )) {
        if (continuesTurn(event)) await flushHeldText();
        events.push(event);
        segmentEvents.push(event);
        if (event.type === "text" && event.content) {
          heldText = event.content;
        }
        if (event.type !== "done") {
          await this.db
            .updateTable("agent_messages")
            .set({
              content: activityLabel(event),
              metadata: progressMetadata(segmentEvents),
            })
            .where("id", "=", assistantMessageId)
            .execute();
        }
      }

      const changedFiles = await this.syncBackChanges(
        identity,
        projectId,
        sandboxProviderId,
      );

      const questionEvent = [...events]
        .reverse()
        .find((event) => event.type === "question");
      const failed = events.some((event) => event.type === "error");

      // The turn ended right after a flushed preamble (no closing text,
      // error, or question): that preamble IS the final message. Drop the
      // dangling placeholder and finalize the flushed row instead.
      const settleFlushed =
        heldText === undefined && !failed && !questionEvent && lastFlushed;
      if (settleFlushed) {
        await this.db
          .deleteFrom("agent_messages")
          .where("id", "=", assistantMessageId)
          .execute();
        assistantMessageId = settleFlushed.id;
        segmentEvents = [...settleFlushed.events, ...segmentEvents];
      }

      const content = settleFlushed
        ? undefined
        : (heldText ??
          (events
            .filter((event) => event.type === "error")
            .map((event) => event.content)
            .join("\n") ||
            (questionEvent ? "" : "(no response)")));

      const metadata: JsonObject = {
        status: failed
          ? "failed"
          : questionEvent
            ? "awaiting_input"
            : "completed",
        events: JSON.parse(JSON.stringify(segmentEvents)) as JsonObject[],
        changedFiles: changedFiles.map((change) => ({ ...change })),
        ...(questionEvent?.questions
          ? {
              questions: JSON.parse(
                JSON.stringify(questionEvent.questions),
              ) as JsonObject[],
            }
          : {}),
      };

      const row = await this.db
        .updateTable("agent_messages")
        .set({ ...(content === undefined ? {} : { content }), metadata })
        .where("id", "=", assistantMessageId)
        .returningAll()
        .executeTakeFirstOrThrow();

      // The agent's set_title tool wins; otherwise the first user message
      // seeds a provisional title.
      const titleEvent = [...events]
        .reverse()
        .find((event) => event.type === "title" && event.content);
      await this.db
        .updateTable("agent_sessions")
        .set({
          updated_at: new Date(),
          ...(titleEvent?.content
            ? { title: truncate(titleEvent.content, 500) }
            : session.title === null
              ? { title: truncate(message, 500) }
              : {}),
        })
        .where("id", "=", sessionId)
        .execute();

      return mapMessage(row);
    } catch (error) {
      await this.db
        .updateTable("agent_messages")
        .set({
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            status: "failed",
            events: JSON.parse(JSON.stringify(events)) as JsonObject[],
          },
        })
        .where("id", "=", assistantMessageId)
        .execute();
      throw error;
    }
  }

  async close(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<AgentSession> {
    const session = await this.requireSession(identity, projectId, sessionId);

    if (session.provider_session_id) {
      await this.codingAgent
        .dispose({
          providerSessionId: session.provider_session_id,
          sandboxId: "",
          workingDirectory: "",
        })
        .catch(() => {});
    }

    const row = await this.db
      .updateTable("agent_sessions")
      .set({ status: "closed", updated_at: new Date() })
      .where("id", "=", sessionId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapSession(row);
  }

  // --- Dev sandbox lifecycle ---

  private projectDir(): string {
    return `${this.sandboxProvider.workspaceRoot}/project`;
  }

  /**
   * Ensure the (project, user) dev sandbox exists and reflects the user's
   * current dev working copy. New sandboxes clone from the project origin
   * when the working copy is clean and in sync with it (the Artifacts-native
   * path); otherwise the working copy files are uploaded. Reused sandboxes
   * are refreshed by upload so the agent always sees the user's drafts.
   */
  private async prepareDevSandbox(
    identity: Identity,
    projectId: string,
  ): Promise<{
    handle: { id: string; providerId: string };
    baseCommitSha: string | null;
  }> {
    const prepared = await this.devSandboxes.ensure({
      identity,
      projectId,
      refresh: true,
    });
    await ensureBatchWorkflowSkill({
      sandboxProvider: this.sandboxProvider,
      sandboxProviderId: prepared.providerId,
      projectDir: this.projectDir(),
    });
    await ensureDurableWorkflowSkill({
      sandboxProvider: this.sandboxProvider,
      sandboxProviderId: prepared.providerId,
      projectDir: this.projectDir(),
    });
    await this.ensureGitBaseline(prepared.providerId);
    return {
      handle: { id: prepared.id, providerId: prepared.providerId },
      baseCommitSha: prepared.baseCommitSha,
    };
  }

  private async commitWorkflowSkillBaseline(
    sandboxProviderId: string,
    skillPaths: readonly string[],
  ): Promise<void> {
    const paths = skillPaths.map(shellQuote).join(" ");
    const command = [
      `cd ${shellQuote(this.projectDir())}`,
      `git add -- ${paths}`,
      `git -c user.name=catamorphic -c user.email=agent@catamorphic.dev commit -m catamorphic-workflow-skills --quiet -- ${paths}`,
    ].join(" && ");
    const result = await this.sandboxProvider.executeCommand(
      sandboxProviderId,
      command,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to baseline workflow skills: ${result.result}`);
    }
  }

  /**
   * Make sure the sandbox project dir is a git repo with a committed
   * baseline, so post-turn change detection (`git status --porcelain`) sees
   * exactly what the agent modified.
   */
  private async ensureGitBaseline(sandboxProviderId: string): Promise<void> {
    const dir = this.projectDir();
    const command = [
      `cd ${shellQuote(dir)}`,
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -b main >/dev/null)",
      "git add -A",
      `(git -c user.name=catamorphic -c user.email=agent@catamorphic.dev commit -m baseline --quiet || true)`,
    ].join(" && ");
    const result = await this.sandboxProvider.executeCommand(
      sandboxProviderId,
      command,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to prepare sandbox git baseline: ${result.result}`,
      );
    }
  }

  private async resolveSandboxProviderId(session: SessionRow): Promise<string> {
    if (!session.sandbox_id) {
      throw new AgentSessionNotFoundError(session.id);
    }
    const row = await this.db
      .selectFrom("project_sandboxes")
      .where("id", "=", session.sandbox_id)
      .select(["provider_id"])
      .executeTakeFirst();
    if (!row) throw new AgentSessionNotFoundError(session.id);

    const status = await this.sandboxProvider.getSandboxStatus(row.provider_id);
    if (status === "stopped" || status === "archived") {
      await this.sandboxProvider.startSandbox(row.provider_id);
    }
    return row.provider_id;
  }

  // --- Change sync-back ---

  /**
   * Diff the sandbox project dir against its git baseline and mirror every
   * change into the user's dev working copy (as an uncommitted draft). The
   * sandbox baseline is then advanced so the next turn diffs incrementally.
   */
  private async syncBackChanges(
    identity: Identity,
    projectId: string,
    sandboxProviderId: string,
  ): Promise<SyncedFileChange[]> {
    const dir = this.projectDir();
    const status = await this.sandboxProvider.executeCommand(
      sandboxProviderId,
      `cd ${shellQuote(dir)} && git status --porcelain --untracked-files=all`,
    );
    if (status.exitCode !== 0) return [];

    const changes = parsePorcelain(status.result).filter(
      (change) =>
        !SYNC_IGNORED_PREFIXES.some((prefix) => change.path.startsWith(prefix)),
    );
    if (changes.length === 0) return [];

    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      for (const change of changes) {
        if (change.kind === "deleted") {
          await repo.deleteFile(change.path).catch(() => {});
        } else {
          const content = await this.sandboxProvider.downloadFile(
            sandboxProviderId,
            `${dir}/${change.path}`,
          );
          await repo.writeFile(change.path, content);
        }
      }
    } finally {
      await repo.dispose();
    }

    // Advance the sandbox baseline so subsequent turns report only new changes.
    await this.sandboxProvider.executeCommand(
      sandboxProviderId,
      `cd ${shellQuote(dir)} && git add -A && (git -c user.name=catamorphic -c user.email=agent@catamorphic.dev commit -m sync --quiet || true)`,
    );

    return changes;
  }

  // --- Plugin docs for the agent ---

  private async loadAttachedPlugins(
    projectId: string,
  ): Promise<AttachedPluginForAgent[] | undefined> {
    if (!this.plugins || !this.pluginResolver) return undefined;
    const resolved = await this.plugins.loadAttachedResolved(projectId);
    if (resolved.length === 0) return undefined;

    const resolver = this.pluginResolver;
    const attached = await Promise.all(
      resolved.map(async (plugin) => {
        const [readme, types] = await Promise.all([
          resolver.readReadme(plugin),
          resolver.readTypes(plugin),
        ]);
        const files: Record<string, string> = {};
        if (readme) files["README.md"] = readme;
        if (types) files[plugin.manifest.docs.types] = types;
        return {
          packageName: plugin.packageName,
          displayName: plugin.manifest.displayName,
          description: plugin.manifest.description,
          files,
        };
      }),
    );
    return attached;
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    assertProjectSurface(identity);
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }

  private async requireSession(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    await this.requireProject(identity, projectId);
    const row = await this.db
      .selectFrom("agent_sessions")
      .where("id", "=", sessionId)
      .where("project_id", "=", projectId)
      .selectAll()
      .executeTakeFirst();
    if (!row) throw new AgentSessionNotFoundError(sessionId);
    return row;
  }
}

function progressMetadata(events: AgentEvent[]): JsonObject {
  return {
    status: "in_progress",
    events: JSON.parse(JSON.stringify(events)) as JsonObject[],
  };
}

export function activityLabel(event: AgentEvent): string {
  if (event.type === "file_edit") {
    return event.filePath ? `Editing ${event.filePath}` : "Editing files...";
  }
  if (event.type === "command") {
    return event.content ? `Running ${event.content}` : "Running a command...";
  }
  if (event.type === "tool_call") {
    return event.toolName ? `Using ${event.toolName}` : "Using a tool...";
  }
  if (event.type === "question") return "Waiting for your answer...";
  if (event.type === "title") return "Thinking...";
  if (event.type === "error") return event.content ?? "Agent failed";
  if (event.type === "text") return event.content ?? "Thinking...";
  return "Thinking...";
}

interface PorcelainChange {
  path: string;
  kind: "modified" | "deleted";
}

/**
 * Parse `git status --porcelain` output into changed paths. Renames
 * (`R  old -> new`) count as a delete of `old` + modify of `new`.
 */
export function parsePorcelain(output: string): PorcelainChange[] {
  const changes: PorcelainChange[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code.includes("R")) {
      const [from, to] = rest.split(" -> ");
      if (from) changes.push({ path: unquotePath(from), kind: "deleted" });
      if (to) changes.push({ path: unquotePath(to), kind: "modified" });
      continue;
    }
    const path = unquotePath(rest);
    if (!path) continue;
    // Without `--untracked-files=all` git reports untracked directories as a
    // single `?? dir/` entry — never a real file, so skip defensively.
    if (path.endsWith("/")) continue;
    changes.push({
      path,
      kind: code.includes("D") ? "deleted" : "modified",
    });
  }
  return changes;
}

function unquotePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function mapSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    projectId: row.project_id,
    externalUserId: row.external_user_id,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    sandboxId: row.sandbox_id,
    title: row.title,
    status: row.status as "active" | "closed",
    baseCommitSha: row.base_commit_sha,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    commitSha: row.commit_sha,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.created_at.toISOString(),
  };
}
