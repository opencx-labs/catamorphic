import type { DB, JsonObject } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  AgentAttachment,
  AgentEffort,
  AgentEvent,
  AttachedPluginForAgent,
  ProviderSession,
  SandboxProvider,
  TurnOptions,
} from "@catamorphic/sandbox";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  DURABLE_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
} from "../templates.js";
import { assertProjectSurface } from "./app-audience.js";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
} from "./coding-agent-registry.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import type { PluginsService } from "./plugins-service.js";
import { ProjectNotFoundError } from "./projects-service.js";
import { type SyncedFileChange, syncSandboxChanges } from "./sandbox-sync.js";

type SessionRow = Selectable<DB["agent_sessions"]>;
type MessageRow = Selectable<DB["agent_messages"]>;

export interface AgentSession {
  id: string;
  projectId: string;
  externalUserId: string;
  provider: string;
  providerSessionId: string | null;
  sandboxId: string | null;
  /** Host-registry key of the agent this session runs on; null = default. */
  agentId: string | null;
  /** Per-session reasoning-effort override; null = the agent's default. */
  modelEffort: AgentEffort | null;
  title: string | null;
  /** Agent-chosen conversation icon ("<name>:<color>"); null = default. */
  icon: string | null;
  /** Session this one was forked from, if any. */
  parentSessionId: string | null;
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

/** The named agent (or the default) is not present in the host's registry. */
export class AgentNotConfiguredError extends Error {
  constructor(readonly agentId: string | undefined) {
    super(
      agentId
        ? `Coding agent '${agentId}' is not configured`
        : "No coding agent is configured",
    );
    this.name = "AgentNotConfiguredError";
  }
}

/** The session has a turn executing right now; retry after it settles. */
export class AgentTurnInProgressError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent session '${sessionId}' has a turn in progress`);
    this.name = "AgentTurnInProgressError";
  }
}

export { parsePorcelain, type SyncedFileChange } from "./sandbox-sync.js";

const tracer = getTracer("@catamorphic/core");

/** Shown in place of a turn that died with the process. */
export const INTERRUPTED_TURN_MESSAGE =
  "This response was interrupted before it finished. Send a new message to continue.";

const WORKFLOW_AUTHORING_SYSTEM_PROMPT = `Every workflow is an exported defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps })) value; runs execute ordered boundary and batch scopes against an immutable deployment, with continuation state persisted in Postgres. There is no "use workflow" directive — IO and business operations live in "use step" functions called from boundary run bodies. Cancellation is a host-issued terminal control declared with controls: { cancel: true }, never a BoundaryContext transition. A workflow may subscribe to host-defined trigger kinds with triggers: [trigger("kind", config)] — the kind name must be a string literal, the config a constant expression, both typed by the generated workflows/src/catamorphic-triggers.d.ts; the fired payload becomes the first step's input. Only exported defineBatchStep calls inside defineBatch.process are physically coalesced. For authoring primitives, use the project's established SaaS wrapper when present; otherwise use @catamorphic/workflow. Never create local copies. Consult .agents/skills/writing-workflows/SKILL.md, .agents/skills/durable-workflows/SKILL.md, and .agents/skills/batch-workflows/SKILL.md, when present, before creating or restructuring workflows.`;

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

/** A chat turn reaching a settled state, for host hooks (e.g. triggers). */
export interface AgentTurnSettledEvent {
  identity: Identity;
  projectId: string;
  sessionId: string;
  messageId: string;
  status: "completed" | "failed" | "awaiting_input";
  changedFiles: string[];
}

interface AgentSessionsDeps {
  projectManager: ProjectManager;
  sandboxProvider: SandboxProvider;
  codingAgents: CodingAgentRegistry;
  devSandboxes: DevSandboxService;
  /**
   * Resolve a project's directory on the host filesystem, for `host`
   * execution-mode agents (Claude Code, Codex — runtimes that operate on
   * local paths). Hosts that only register sandbox agents can omit it.
   */
  hostProjectPath?: (
    projectId: string,
  ) => Promise<string | undefined> | string | undefined;
  plugins?: PluginsService;
  pluginResolver?: PluginResolver;
  /**
   * Fires after a turn's settled state is durably recorded. Host-owned:
   * exceptions are swallowed, and the turn's response never waits on it.
   */
  onTurnSettled?: (event: AgentTurnSettledEvent) => void | Promise<void>;
}

/**
 * Orchestrates coding-agent sessions across the host's registry of agents:
 *
 * 1. Sessions are created lazily — the row exists immediately, and the
 *    provider session (plus, for sandbox agents, the per-(project, user)
 *    dev sandbox) is anchored on the first turn. Switching a session to a
 *    different agent just clears the anchor; the next turn re-anchors.
 * 2. `sandbox` agents run against the dev sandbox and their changes sync
 *    back into the user's dev working copy as an uncommitted draft.
 *    `host` agents run directly in the project's host directory — their
 *    edits land in place, so no sync step and no draft.
 * 3. The conversation persists to `agent_sessions` / `agent_messages`.
 */
export class AgentSessionsService {
  private readonly projectManager: ProjectManager;
  private readonly sandboxProvider: SandboxProvider;
  private readonly codingAgents: CodingAgentRegistry;
  private readonly hostProjectPath?: AgentSessionsDeps["hostProjectPath"];
  private readonly plugins?: PluginsService;
  private readonly pluginResolver?: PluginResolver;
  private readonly devSandboxes: DevSandboxService;
  private readonly onTurnSettled?: AgentSessionsDeps["onTurnSettled"];
  /**
   * Sessions with a turn currently executing in this process. Turns run
   * inside the send request, so an `in_progress` message whose session is
   * not in this set is orphaned (the app/server died mid-turn) — reads
   * settle it as failed so clients never spin on a dead turn.
   */
  private readonly runningTurns = new Set<string>();
  /** Sessions whose in-flight turn was interrupted by the user. */
  private readonly interruptedTurns = new Set<string>();
  /** Scheduled automatic retries (transient provider failures). */
  private readonly autoRetries = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; attempt: number }
  >();

  constructor(
    private readonly db: Kysely<DB>,
    deps: AgentSessionsDeps,
  ) {
    this.projectManager = deps.projectManager;
    this.sandboxProvider = deps.sandboxProvider;
    this.codingAgents = deps.codingAgents;
    this.hostProjectPath = deps.hostProjectPath;
    this.devSandboxes = deps.devSandboxes;
    this.plugins = deps.plugins;
    this.pluginResolver = deps.pluginResolver;
    this.onTurnSettled = deps.onTurnSettled;
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
    const settled = await this.settleOrphanedTurns(sessionId, messages);
    return { ...mapSession(row), messages: settled.map(mapMessage) };
  }

  /**
   * Finalize `in_progress` assistant messages left behind by a turn that
   * died with the process (app quit, crash, dev restart). Without this the
   * placeholder stays in-progress forever and every client shows a spinner
   * that never stops.
   */
  private async settleOrphanedTurns(
    sessionId: string,
    messages: MessageRow[],
  ): Promise<MessageRow[]> {
    if (this.runningTurns.has(sessionId)) return messages;
    const orphaned = messages.filter(
      (message) =>
        message.role === "assistant" &&
        (message.metadata as JsonObject | null)?.status === "in_progress",
    );
    if (orphaned.length === 0) return messages;

    const updated = new Map<string, MessageRow>();
    for (const message of orphaned) {
      const row = await this.db
        .updateTable("agent_messages")
        .set({
          content: INTERRUPTED_TURN_MESSAGE,
          metadata: {
            ...(message.metadata as JsonObject | null),
            status: "failed",
            interrupted: true,
          },
        })
        .where("id", "=", message.id)
        // The turn may have finished (or been settled by a concurrent read)
        // between our select and this update — only settle a still-pending row.
        .where(sql`metadata ->> 'status'`, "=", "in_progress")
        .returningAll()
        .executeTakeFirst();
      if (row) updated.set(row.id, row);
    }
    if (updated.size === 0) return messages;
    return messages.map((message) => updated.get(message.id) ?? message);
  }

  async create(
    identity: Identity,
    projectId: string,
    input: {
      systemPrompt?: string;
      agentId?: string;
      effort?: AgentEffort;
    } = {},
  ): Promise<AgentSession> {
    return withSpan(
      {
        tracer,
        name: "agent.session.create",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.tenant.id": identity.tenantId,
          ...(input.agentId ? { "catamorphic.agent.id": input.agentId } : {}),
        },
      },
      () => this.createInner(identity, projectId, input),
    );
  }

  private async createInner(
    identity: Identity,
    projectId: string,
    input: { systemPrompt?: string; agentId?: string; effort?: AgentEffort },
  ): Promise<AgentSession> {
    await this.requireProject(identity, projectId);
    // Validate up front so a bad agent id fails at create, not first send.
    const agent = this.resolveAgent(input.agentId ?? null);

    // Lazy anchoring: the provider session (and, for sandbox agents, the dev
    // sandbox) is established on the first turn. Creating a session is a
    // metadata write — cheap, and switching agents before the first message
    // costs nothing.
    const row = await this.db
      .insertInto("agent_sessions")
      .values({
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: agent.provider.name,
        provider_session_id: null,
        agent_id: input.agentId ?? null,
        model_effort: input.effort ?? null,
        system_prompt: input.systemPrompt ?? null,
        sandbox_id: null,
        status: "active",
        base_commit_sha: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapSession(row);
  }

  /**
   * Re-point a session at another registered agent and/or change its
   * reasoning-effort override (`effort: null` clears the override back to
   * the agent's default). Switching agents drops the provider anchor; the
   * next turn re-anchors against the new provider (same working state, but
   * the new provider starts from its own fresh context).
   */
  async update(
    identity: Identity,
    projectId: string,
    sessionId: string,
    patch: { agentId?: string; effort?: AgentEffort | null },
  ): Promise<AgentSession> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnInProgressError(sessionId);
    }

    const updates: Partial<{
      agent_id: string;
      provider: string;
      provider_session_id: null;
      model_effort: string | null;
    }> = {};

    if (patch.agentId !== undefined && patch.agentId !== session.agent_id) {
      const agent = this.codingAgents.get(patch.agentId);
      if (!agent) throw new AgentNotConfiguredError(patch.agentId);
      // Let the outgoing provider release its in-memory state.
      if (session.provider_session_id) {
        const previous = this.codingAgents.get(
          session.agent_id ?? this.codingAgents.defaultAgentId() ?? "",
        );
        await previous?.provider
          .dispose({
            providerSessionId: session.provider_session_id,
            sessionId: session.id,
            projectId,
            sandboxId: "",
            workingDirectory: "",
          })
          .catch(() => {});
      }
      updates.agent_id = patch.agentId;
      updates.provider = agent.provider.name;
      updates.provider_session_id = null;
    }
    if (patch.effort !== undefined) {
      updates.model_effort = patch.effort;
    }

    if (Object.keys(updates).length === 0) return mapSession(session);

    const row = await this.db
      .updateTable("agent_sessions")
      .set({ ...updates, updated_at: new Date() })
      .where("id", "=", sessionId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Leave a marker in the transcript so the conversation shows where the
    // agent or effort changed. System rows with `metadata.marker` render as
    // dividers, not messages.
    const markers: Array<{ content: string; marker: JsonObject }> = [];
    if (updates.agent_id !== undefined) {
      markers.push({
        content: "Agent changed",
        marker: { kind: "agent_change", agentId: updates.agent_id },
      });
    }
    if (updates.model_effort !== undefined && updates.agent_id === undefined) {
      markers.push({
        content: `Effort set to ${updates.model_effort ?? "default"}`,
        marker: { kind: "effort_change", effort: updates.model_effort },
      });
    }
    for (const entry of markers) {
      await this.db
        .insertInto("agent_messages")
        .values({
          session_id: sessionId,
          role: "system",
          content: entry.content,
          metadata: { marker: entry.marker },
        })
        .execute();
    }
    return mapSession(row);
  }

  /**
   * Set the session's conversation icon ("<name>:<color>"; null clears).
   * Deliberately not part of {@link update}: agents set icons mid-turn
   * (their own turn), and update() refuses while a turn runs.
   */
  async setIcon(
    identity: Identity,
    projectId: string,
    sessionId: string,
    icon: string | null,
  ): Promise<AgentSession> {
    await this.requireSession(identity, projectId, sessionId);
    const row = await this.db
      .updateTable("agent_sessions")
      .set({ icon, updated_at: new Date() })
      .where("id", "=", sessionId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSession(row);
  }

  /**
   * Fork a conversation: a NEW session on the same agent carrying a copy
   * of the transcript up to (and including) `messageId` — or the whole
   * settled transcript when omitted. The fork records its parent, opens
   * with a marker row, and its first turn re-anchors from the copied
   * history exactly like a host-restart recovery would; the parent stays
   * untouched.
   */
  async fork(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: { messageId?: string } = {},
  ): Promise<AgentSession> {
    const session = await this.requireSession(identity, projectId, sessionId);
    const messages = await this.db
      .selectFrom("agent_messages")
      .where("session_id", "=", sessionId)
      .selectAll()
      .orderBy("seq", "asc")
      .execute();

    let copied = messages;
    if (input.messageId) {
      const cut = messages.findIndex(
        (message) => message.id === input.messageId,
      );
      if (cut === -1) {
        throw new AgentSessionNotFoundError(input.messageId);
      }
      copied = messages.slice(0, cut + 1);
    }
    // Only settled content forks: an in-flight or failed tail would give
    // the new conversation a phantom turn.
    copied = copied.filter((message) => {
      const status = (message.metadata as JsonObject | null)?.status;
      return status !== "in_progress" && status !== "failed";
    });

    const forkTitle = session.title ? `${session.title} (fork)` : null;
    // Marker rows never reach the harness (transcriptHistory drops them),
    // so the fork's self-awareness travels in its system prompt: the
    // first anchored turn already knows it's on a tangent.
    const forkNote = `This conversation is a fork of ${
      session.title
        ? `the conversation "${session.title}"`
        : "another conversation"
    }: it starts from a copy of that transcript up to the fork point. The user is exploring a tangent here — the original conversation continues separately, so don't refer to this one as if it were the original.`;
    const forkSystemPrompt = [session.system_prompt, forkNote]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const row = await this.db.transaction().execute(async (trx) => {
      const fork = await trx
        .insertInto("agent_sessions")
        .values({
          project_id: projectId,
          external_user_id: identity.externalUserId,
          provider: session.provider,
          provider_session_id: null,
          agent_id: session.agent_id,
          model_effort: session.model_effort,
          system_prompt: forkSystemPrompt,
          sandbox_id: null,
          status: "active",
          base_commit_sha: session.base_commit_sha,
          icon: session.icon,
          parent_session_id: sessionId,
          title: forkTitle,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const message of copied) {
        await trx
          .insertInto("agent_messages")
          .values({
            session_id: fork.id,
            role: message.role,
            content: message.content,
            commit_sha: message.commit_sha,
            metadata: message.metadata,
          })
          .execute();
      }
      // The divider that tells both the user and the agent where this
      // conversation came from.
      await trx
        .insertInto("agent_messages")
        .values({
          session_id: fork.id,
          role: "system",
          content: session.title
            ? `Forked from "${session.title}"`
            : "Forked from another conversation",
          metadata: {
            marker: { kind: "fork", parentSessionId: sessionId },
          },
        })
        .execute();
      return fork;
    });
    return mapSession(row);
  }

  async sendMessage(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
    input: { attachments?: AgentAttachment[] } = {},
  ): Promise<AgentMessage> {
    return withSpan(
      {
        tracer,
        name: "agent.session.message",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.agent.session.id": sessionId,
        },
      },
      () =>
        this.sendMessageInner(identity, projectId, sessionId, message, input),
    );
  }

  private async sendMessageInner(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
    input: { attachments?: AgentAttachment[] } = {},
  ): Promise<AgentMessage> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }
    // A fresh user message supersedes any scheduled automatic retry.
    this.cancelAutoRetry(sessionId);
    // Marked running BEFORE the placeholder row exists, so a concurrent
    // get() can never mistake this turn's placeholder for an orphan.
    this.runningTurns.add(sessionId);
    try {
      return await this.runTurn(identity, projectId, sessionId, message, {
        session,
        attachments: input.attachments,
      });
    } finally {
      this.runningTurns.delete(sessionId);
    }
  }

  /**
   * Re-run the session's last failed turn in place: the failed assistant
   * row flips back to in-progress and the harness re-executes without a
   * new user message ({@link CodingAgentProvider.retryTurn}; harnesses
   * without it get the last user message re-sent). `model_incompat`
   * failures retry with sanitized reasoning history.
   */
  async retry(
    identity: Identity,
    projectId: string,
    sessionId: string,
    opts: { autoAttempt?: number } = {},
  ): Promise<AgentMessage> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnInProgressError(sessionId);
    }
    this.cancelAutoRetry(sessionId);

    const messages = await this.db
      .selectFrom("agent_messages")
      .where("session_id", "=", sessionId)
      .selectAll()
      .orderBy("seq", "desc")
      .limit(20)
      .execute();
    const failed = messages.find((row) => row.role === "assistant");
    const failedMetadata = failed?.metadata as JsonObject | null;
    if (!failed || failedMetadata?.status !== "failed") {
      throw new Error("The last turn did not fail; nothing to retry");
    }
    const lastUser = messages.find((row) => row.role === "user");
    if (!lastUser) throw new Error("No user message to retry");
    const userMetadata = lastUser.metadata as JsonObject | null;

    this.runningTurns.add(sessionId);
    try {
      return await this.runTurn(
        identity,
        projectId,
        sessionId,
        lastUser.content,
        {
          session,
          attachments: (userMetadata?.attachments ??
            undefined) as unknown as AgentAttachment[],
          retryOfAssistantId: failed.id,
          sanitizeReasoning: failedMetadata?.errorKind === "model_incompat",
          autoAttempt: opts.autoAttempt,
        },
      );
    } finally {
      this.runningTurns.delete(sessionId);
    }
  }

  /**
   * Abort the session's in-flight turn (and cancel any scheduled
   * auto-retry). The running turn settles as an interrupted failure; the
   * session stays usable.
   */
  async interrupt(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.requireSession(identity, projectId, sessionId);
    this.cancelAutoRetry(sessionId);
    if (!this.runningTurns.has(sessionId)) return;
    this.interruptedTurns.add(sessionId);
    if (session.provider_session_id) {
      try {
        const agent = this.resolveAgent(session.agent_id);
        agent.provider.interrupt?.(session.provider_session_id);
      } catch {
        // No resolvable agent — nothing to signal; the turn settles alone.
      }
    }
  }

  private cancelAutoRetry(sessionId: string): void {
    const scheduled = this.autoRetries.get(sessionId);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.autoRetries.delete(sessionId);
  }

  /**
   * Transient failures (rate limits, provider outages) retry on their own:
   * 5s → 15s → 30s → then every 60s until the provider recovers, the user
   * acts (new message, manual retry, interrupt), or the session closes.
   * The failed row carries `autoRetry` metadata so clients can show the
   * countdown.
   */
  private scheduleAutoRetry(
    identity: Identity,
    projectId: string,
    sessionId: string,
    assistantMessageId: string,
    attempt: number,
  ): void {
    const delays = [5_000, 15_000, 30_000, 60_000];
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 60_000;
    void this.db
      .updateTable("agent_messages")
      .set(({ ref }) => ({
        metadata: sql`${ref("metadata")} || ${JSON.stringify({
          autoRetry: { attempt: attempt + 1, nextAtMs: Date.now() + delay },
        })}::jsonb`,
      }))
      .where("id", "=", assistantMessageId)
      .execute()
      .catch(() => {});
    const timer = setTimeout(() => {
      this.autoRetries.delete(sessionId);
      void this.retry(identity, projectId, sessionId, {
        autoAttempt: attempt + 1,
      }).catch(() => {
        // A concurrent user action raced the retry — it owns the session.
      });
    }, delay);
    this.autoRetries.set(sessionId, { timer, attempt });
  }

  private async runTurn(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
    extras: {
      session: SessionRow;
      attachments?: AgentAttachment[];
      /** Retry: reuse this failed assistant row instead of inserting. */
      retryOfAssistantId?: string;
      sanitizeReasoning?: boolean;
      /** Set on automatic retries; drives the next backoff step. */
      autoAttempt?: number;
    },
  ): Promise<AgentMessage> {
    // Note: no stale-flag clearing needed here — interrupt() only sets the
    // flag while a turn is marked running, and every turn consumes it on
    // the way out (success and error paths both delete).
    const { session } = extras;
    const agent = this.resolveAgent(session.agent_id);
    const attachments = extras.attachments?.length
      ? extras.attachments
      : undefined;
    const turnOptions: TurnOptions = {
      ...agent.defaults,
      ...(session.model_effort
        ? { effort: session.model_effort as AgentEffort }
        : {}),
      ...(attachments ? { attachments } : {}),
    };

    // Persist the user message and the in-progress placeholder BEFORE the
    // (potentially slow) provider/sandbox anchoring: the turn is then
    // visible and crash-recoverable from the moment it starts — a process
    // death during anchoring settles as an interrupted turn instead of a
    // silently vanished message. Retries reuse the failed assistant row —
    // the conversation continues in place, no duplicate user message.
    let assistantMessageId: string;
    if (extras.retryOfAssistantId) {
      assistantMessageId = extras.retryOfAssistantId;
      await this.db
        .updateTable("agent_messages")
        .set({ content: "Thinking...", metadata: progressMetadata([]) })
        .where("id", "=", assistantMessageId)
        .execute();
    } else {
      assistantMessageId = await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("agent_messages")
          .values({
            session_id: sessionId,
            role: "user",
            content: message,
            ...(attachments
              ? {
                  metadata: {
                    attachments: JSON.parse(
                      JSON.stringify(attachments),
                    ) as JsonObject[],
                  },
                }
              : {}),
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
    }

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
      event.type === "file_edit" ||
      event.type === "subagent" ||
      event.type === "background";

    try {
      const anchor = await this.ensureAnchor(
        identity,
        projectId,
        session,
        agent,
      );

      if (anchor.sandboxProviderId) {
        const workingDirectory = this.projectDir();
        const batchSkillStaged = await ensureBatchWorkflowSkill({
          sandboxProvider: this.sandboxProvider,
          sandboxProviderId: anchor.sandboxProviderId,
          projectDir: workingDirectory,
        });
        const durableSkillStaged = await ensureDurableWorkflowSkill({
          sandboxProvider: this.sandboxProvider,
          sandboxProviderId: anchor.sandboxProviderId,
          projectDir: workingDirectory,
        });
        const stagedSkillPaths = [
          ...(batchSkillStaged ? [BATCH_WORKFLOW_SKILL_PATH] : []),
          ...(durableSkillStaged ? [DURABLE_WORKFLOW_SKILL_PATH] : []),
        ];
        if (stagedSkillPaths.length > 0) {
          await this.commitWorkflowSkillBaseline(
            anchor.sandboxProviderId,
            stagedSkillPaths,
          );
        }
      }

      // An interrupt can land while the turn is still anchoring (rows,
      // sandbox, skills) — before any provider signal exists to abort. The
      // latched flag catches it here: the turn settles as interrupted
      // without ever calling the provider. Checked with has() (not
      // delete()) so the finalization below still reads it as interrupted.
      const stream = this.interruptedTurns.has(sessionId)
        ? (async function* (): AsyncIterable<AgentEvent> {
            yield { type: "error", content: "Interrupted." };
            yield { type: "done" };
          })()
        : // Retries prefer the harness's native re-run (no duplicated user
          // message in its history); harnesses without one get a re-send.
          extras.retryOfAssistantId && agent.provider.retryTurn
          ? agent.provider.retryTurn(anchor.providerSession, {
              ...turnOptions,
              sanitizeReasoning: extras.sanitizeReasoning,
            })
          : agent.provider.sendMessage(
              anchor.providerSession,
              message,
              turnOptions,
            );
      for await (const event of stream) {
        // A harness that only learns its native session id once the first
        // turn starts (Codex) reports it here; persist it so later turns
        // resume the same thread. Pure anchoring signal — never recorded
        // as turn content.
        if (event.type === "session") {
          if (event.providerSessionId) {
            anchor.providerSession.providerSessionId = event.providerSessionId;
            await this.db
              .updateTable("agent_sessions")
              .set({ provider_session_id: event.providerSessionId })
              .where("id", "=", sessionId)
              .execute();
          }
          continue;
        }
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

      const changedFiles = anchor.sandboxProviderId
        ? await this.syncBackChanges(
            identity,
            projectId,
            anchor.sandboxProviderId,
          )
        : hostChangedFiles(events, anchor.providerSession.workingDirectory);

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

      const interrupted = this.interruptedTurns.delete(sessionId);
      const errorKind = interrupted
        ? undefined
        : [...events]
            .reverse()
            .find((event) => event.type === "error" && event.errorKind)
            ?.errorKind;
      const metadata: JsonObject = {
        status: failed
          ? "failed"
          : questionEvent
            ? "awaiting_input"
            : "completed",
        events: JSON.parse(JSON.stringify(segmentEvents)) as JsonObject[],
        changedFiles: changedFiles.map((change) => ({ ...change })),
        ...(errorKind ? { errorKind } : {}),
        ...(interrupted && failed ? { interrupted: true } : {}),
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

      if (this.onTurnSettled) {
        const settled: AgentTurnSettledEvent = {
          identity,
          projectId,
          sessionId,
          messageId: assistantMessageId,
          status: metadata.status as AgentTurnSettledEvent["status"],
          changedFiles: changedFiles.map((change) => change.path),
        };
        void Promise.resolve()
          .then(() => this.onTurnSettled?.(settled))
          .catch((error) => {
            console.warn(
              `[catamorphic] onTurnSettled hook failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }

      // Transient provider failures keep retrying on their own; the user
      // sees the error and the countdown, and can retry now or move on.
      if (
        failed &&
        (errorKind === "rate_limit" || errorKind === "unavailable")
      ) {
        this.scheduleAutoRetry(
          identity,
          projectId,
          sessionId,
          assistantMessageId,
          extras.autoAttempt ?? 0,
        );
      }

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
      this.interruptedTurns.delete(sessionId);
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
    this.cancelAutoRetry(sessionId);

    if (session.provider_session_id) {
      const agent = this.codingAgents.get(
        session.agent_id ?? this.codingAgents.defaultAgentId() ?? "",
      );
      await agent?.provider
        .dispose({
          providerSessionId: session.provider_session_id,
          sessionId: session.id,
          projectId,
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

  // --- Agent resolution & anchoring ---

  private resolveAgent(agentId: string | null): RegisteredCodingAgent {
    const id = agentId ?? this.codingAgents.defaultAgentId();
    if (!id) throw new AgentNotConfiguredError(undefined);
    const agent = this.codingAgents.get(id);
    if (!agent) throw new AgentNotConfiguredError(id);
    return agent;
  }

  /**
   * Make sure the session has a live provider session for its current agent,
   * establishing one (and, for sandbox agents, the dev sandbox) when the
   * session is new, was switched to another agent, or the registry now maps
   * its agent to a different harness.
   */
  private async ensureAnchor(
    identity: Identity,
    projectId: string,
    session: SessionRow,
    agent: RegisteredCodingAgent,
  ): Promise<{
    providerSession: ProviderSession;
    sandboxProviderId?: string;
  }> {
    const anchored =
      session.provider_session_id !== null &&
      session.provider === agent.provider.name &&
      // In-memory harness sessions die with a host restart or a provider
      // rebuild (credential/config edits drop the cached instance). When
      // the harness can tell us the session is gone, re-anchor with the
      // persisted transcript instead of running into a dead session.
      (agent.provider.hasSession?.(session.provider_session_id) ?? true);

    if (agent.execution === "host") {
      const workingDirectory = await this.resolveHostPath(projectId);
      if (anchored && session.provider_session_id) {
        return {
          providerSession: {
            providerSessionId: session.provider_session_id,
            sessionId: session.id,
            projectId,
            sandboxId: "",
            workingDirectory,
          },
        };
      }
      const providerSession = await agent.provider.startSession({
        projectId,
        userId: identity.externalUserId,
        sandboxId: "",
        workingDirectory,
        sessionId: session.id,
        systemPrompt: buildAgentSystemPrompt({
          systemPrompt: session.system_prompt ?? undefined,
        }),
        attachedPlugins: await this.loadAttachedPlugins(projectId),
        history: await this.transcriptHistory(session.id),
      });
      await this.db
        .updateTable("agent_sessions")
        .set({
          provider: agent.provider.name,
          provider_session_id: providerSession.providerSessionId,
        })
        .where("id", "=", session.id)
        .execute();
      return { providerSession };
    }

    if (anchored && session.provider_session_id && session.sandbox_id) {
      const sandboxProviderId = await this.resolveSandboxProviderId(session);
      return {
        providerSession: {
          providerSessionId: session.provider_session_id,
          sessionId: session.id,
          projectId,
          sandboxId: sandboxProviderId,
          workingDirectory: this.projectDir(),
        },
        sandboxProviderId,
      };
    }

    const { handle, baseCommitSha } = await this.prepareDevSandbox(
      identity,
      projectId,
    );
    const providerSession = await agent.provider.startSession({
      projectId,
      userId: identity.externalUserId,
      sandboxId: handle.providerId,
      workingDirectory: this.projectDir(),
      sessionId: session.id,
      systemPrompt: buildAgentSystemPrompt({
        systemPrompt: session.system_prompt ?? undefined,
      }),
      attachedPlugins: await this.loadAttachedPlugins(projectId),
      history: await this.transcriptHistory(session.id),
    });
    await this.db
      .updateTable("agent_sessions")
      .set({
        provider: agent.provider.name,
        provider_session_id: providerSession.providerSessionId,
        sandbox_id: handle.id,
        base_commit_sha: baseCommitSha,
      })
      .where("id", "=", session.id)
      .execute();
    return { providerSession, sandboxProviderId: handle.providerId };
  }

  /**
   * The session's settled conversation, shaped for
   * {@link StartSessionOpts.history}: completed user/assistant turns only —
   * no markers, no failed/in-progress rows, and NOT the current turn (its
   * user row is persisted before anchoring and travels as the message
   * itself). Capped so resurrection never ships an unbounded transcript.
   */
  private async transcriptHistory(
    sessionId: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const rows = await this.db
      .selectFrom("agent_messages")
      .where("session_id", "=", sessionId)
      .select(["role", "content", "metadata"])
      .orderBy("seq", "asc")
      .execute();
    // Everything from the current turn's user row onward is in flight.
    let lastUserIndex = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const settled = lastUserIndex === -1 ? rows : rows.slice(0, lastUserIndex);
    const history = settled.flatMap(
      (row): Array<{ role: "user" | "assistant"; content: string }> => {
        if (row.role !== "user" && row.role !== "assistant") return [];
        if (row.content.trim().length === 0) return [];
        const status = (row.metadata as JsonObject | null)?.status;
        if (
          row.role === "assistant" &&
          status !== "completed" &&
          status !== "awaiting_input"
        ) {
          return [];
        }
        return [{ role: row.role, content: row.content }];
      },
    );
    const capped: typeof history = [];
    let totalChars = 0;
    for (const turn of history.reverse()) {
      totalChars += turn.content.length;
      if (capped.length >= 40 || totalChars > 32_000) break;
      capped.unshift(turn);
    }
    return capped;
  }

  private async resolveHostPath(projectId: string): Promise<string> {
    const path = await this.hostProjectPath?.(projectId);
    if (!path) {
      throw new Error(
        "This agent runs on the host machine, but the project has no host directory",
      );
    }
    return path;
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
    return syncSandboxChanges({
      provider: this.sandboxProvider,
      projectManager: this.projectManager,
      identity,
      projectId,
      sandboxProviderId,
      projectDir: this.projectDir(),
    });
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
    // Deliberately no file name: the live line stays calm and human; the
    // full path is in the turn's event log for anyone who expands it.
    return "Editing files...";
  }
  if (event.type === "command") {
    return commandLabel(event.content);
  }
  if (event.type === "tool_call") {
    // Tool names are technical (harness- and MCP-speak); the expanded
    // event log carries them, the live line stays plain.
    return "Working...";
  }
  if (event.type === "subagent") {
    if (event.status === "ended") return "Subagent finished...";
    return event.content
      ? `Delegating: ${event.content}`
      : "Delegating to a subagent...";
  }
  if (event.type === "background") {
    if (event.status === "ended") return "Stopped a background process...";
    return event.content
      ? `Running in background: ${event.content}`
      : "Started a background process...";
  }
  if (event.type === "question") return "Waiting for your answer...";
  if (event.type === "title") return "Thinking...";
  if (event.type === "error") return event.content ?? "Agent failed";
  if (event.type === "text") return event.content ?? "Thinking...";
  return "Thinking...";
}

/**
 * Human labels for well-known shell commands. The live activity line never
 * shows a raw command (long, technical, sometimes noisy); a recognized
 * program gets a friendly verb and everything else is just "Working...".
 */
const COMMAND_LABELS: Record<string, string> = {
  sleep: "Waiting...",
  find: "Searching files...",
  grep: "Searching files...",
  rg: "Searching files...",
  ag: "Searching files...",
  ls: "Looking around...",
  tree: "Looking around...",
  pwd: "Looking around...",
  cat: "Reading files...",
  head: "Reading files...",
  tail: "Reading files...",
  wc: "Reading files...",
  mkdir: "Creating files...",
  touch: "Creating files...",
  cp: "Copying files...",
  mv: "Moving files...",
  git: "Working with git...",
  curl: "Fetching a URL...",
  wget: "Fetching a URL...",
  make: "Building...",
  cargo: "Building...",
  tsc: "Building...",
  npm: "Running scripts...",
  npx: "Running scripts...",
  pnpm: "Running scripts...",
  yarn: "Running scripts...",
  bun: "Running scripts...",
  bunx: "Running scripts...",
  node: "Running code...",
  python: "Running code...",
  python3: "Running code...",
  vitest: "Running tests...",
  jest: "Running tests...",
  pytest: "Running tests...",
};

function commandLabel(command: string | undefined): string {
  if (!command) return "Working...";
  // First program of the first pipeline segment, skipping env assignments
  // and trivial wrappers; compound commands classify by what runs first.
  const segment = command.split(/\s*(?:&&|\|\||[;|])\s*/, 1)[0] ?? "";
  const words = segment.trim().split(/\s+/);
  let program: string | undefined;
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // env assignment
    if (word === "env" || word === "sudo" || word === "command") continue;
    program = word.split("/").pop();
    break;
  }
  return (program && COMMAND_LABELS[program]) ?? "Working...";
}

/**
 * Changed files for a host-execution turn: there is no sandbox baseline to
 * diff, so the provider's `file_edit` events are the record. Paths are
 * relativized to the working directory so chips read like repo paths.
 */
export function hostChangedFiles(
  events: AgentEvent[],
  workingDirectory: string,
): SyncedFileChange[] {
  const root = workingDirectory.endsWith("/")
    ? workingDirectory
    : `${workingDirectory}/`;
  const seen = new Set<string>();
  const changes: SyncedFileChange[] = [];
  for (const event of events) {
    if (event.type !== "file_edit" || !event.filePath) continue;
    const path = event.filePath.startsWith(root)
      ? event.filePath.slice(root.length)
      : event.filePath;
    if (seen.has(path)) continue;
    seen.add(path);
    changes.push({ path, kind: "modified" });
  }
  return changes;
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
    agentId: row.agent_id,
    modelEffort: (row.model_effort as AgentEffort | null) ?? null,
    title: row.title,
    icon: row.icon,
    parentSessionId: row.parent_session_id,
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
