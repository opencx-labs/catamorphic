import { randomUUID } from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { PluginResolver } from "@catamorphic/plugins";
import {
  type AgentAttachment,
  type AgentEffort,
  type AgentEvent,
  type AgentMcpServerConfig,
  type AttachedPluginForAgent,
  type McpToolPolicyLayers,
  messageWithAttachmentNames,
  narrowingLayer,
  PROJECT_TOOLS_SERVER_KEY,
  type ProviderSession,
  type SandboxProvider,
  serverKeyOf,
  type ToolPermission,
  type TurnOptions,
} from "@catamorphic/sandbox";
import { type Kysely, type Selectable, sql } from "kysely";
import {
  type AgentRef,
  type Identity,
  isBuilder,
  scopeCovers,
} from "../identity.js";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  DURABLE_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
} from "../seeds.js";
import {
  formatProjectAgentId,
  parseProjectAgentId,
} from "./agent-definitions-service.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import {
  AgentTurnsService,
  type PendingSessionTurn,
  type SessionDeliveryMode,
  type SessionDeliveryReceipt,
  type SessionMessageAuthor,
} from "./agent-turns-service.js";
import type { AppPoliciesService } from "./app-policies-service.js";
import { AccessDeniedError, resolveScope } from "./artifact-scope.js";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
} from "./coding-agent-registry.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ConnectionCapabilityGrantsService } from "./connection-capability-grants.js";
import { connectionMcpServerName } from "./connection-types.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import type { DocumentsService } from "./documents-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import type { ExecutionEnvironmentsService } from "./execution-environments-service.js";
import type { PluginsService } from "./plugins-service.js";
import { PROGRAM_READER } from "./program-reader.js";
import { requireTenantProject } from "./projects-service.js";
import { type SyncedFileChange, syncSandboxChanges } from "./sandbox-sync.js";
import {
  SessionMailboxesService,
  type SessionMailboxItem,
} from "./session-mailboxes-service.js";
import {
  documentsClientFor,
  shipRemoteProject,
  syncRemoteProject,
} from "./store-sync.js";

type SessionRow = Selectable<DB["agent_sessions"]>;
type MessageRow = Selectable<DB["agent_messages"]>;

export type AgentSessionSource =
  | "desktop"
  | "mobile"
  | "slack"
  | "claude"
  | "mcp"
  | "api";

export interface AgentSession {
  id: string;
  projectId: string;
  externalUserId: string;
  provider: string;
  /** Surface that first created this conversation; informational, not auth. */
  source: AgentSessionSource;
  providerSessionId: string | null;
  sandboxId: string | null;
  environment: string | null;
  allocationId: string | null;
  /** Host-registry key of the agent this session runs on; null = default. */
  agentId: string | null;
  /** Per-session reasoning-effort override; null = the agent's default. */
  modelEffort: AgentEffort | null;
  title: string | null;
  /** Agent-chosen conversation icon ("<name>:<color>"); null = default. */
  icon: string | null;
  /** Session this one was forked from, if any. */
  parentSessionId: string | null;
  /** Short agent-published description used to coordinate project peers. */
  activity: string | null;
  /** Current agent-owned progress list for this conversation. */
  todos: AgentTodo[];
  /** Host currently responsible for executing this session's turns. */
  authorityHostId: string;
  /** Monotonic fencing token for cross-host delivery. */
  authorityRevision: number;
  /** Last time this host observed the current authority's stable snapshot. */
  authoritySeenAt: string;
  /** Number of transcript messages imported with the current mirror. */
  mirrorMessageCount: number;
  /** A coordinated move blocks local sends while remote authority is claimed. */
  handoffStatus: "none" | "pending";
  handoffDestinationHostId: string | null;
  /** True only on a non-authority host with an expired source lease. */
  resumable: boolean;
  /** When the source lease expired, or null while the session is not paused. */
  pausedAt: string | null;
  /** Runtime state in this host process; never persisted. */
  running: boolean;
  /** Monotonic server-owned request for the user to open this session. */
  attentionRevision: number;
  /** Latest attention request the user has acknowledged by opening it. */
  attentionSeenRevision: number;
  /** True when this session should pulse in the user's clients. */
  attentionRequired: boolean;
  status: "active" | "closed";
  baseCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionWakeReceipt extends SessionDeliveryReceipt {
  sessionId: string;
  sessionCreated: boolean;
}

export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export interface AgentTodo {
  /** Stable within this session, generated by the host for new items. */
  id: string;
  /** Short action phrase shown in the collapsed list. */
  title: string;
  /** Important task detail, collapsed by default in the UI. */
  description: string;
  status: AgentTodoStatus;
}

export interface AgentTodoInput {
  /** Echo the returned id when editing an existing item; omit for new items. */
  id?: string;
  title: string;
  description: string;
  status: AgentTodoStatus;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  commitSha: string | null;
  metadata: Record<string, unknown> | null;
  author: SessionMessageAuthor;
  deliveryMode: SessionDeliveryMode;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface AgentSessionDetail extends AgentSession {
  messages: AgentMessage[];
  pendingTurns: PendingSessionTurn[];
}

export interface AgentSessionPeer {
  id: string;
  projectId: string;
  title: string | null;
  agentId: string | null;
  running: boolean;
  task: string | null;
  activity: string | null;
  updatedAt: string;
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

export class AgentSessionAuthorityRequiredError extends Error {
  constructor(
    readonly sessionId: string,
    readonly authorityHostId: string,
    readonly authorityRevision: number,
  ) {
    super(`Agent session '${sessionId}' must be resumed on this host first`);
    this.name = "AgentSessionAuthorityRequiredError";
  }
}

export class AgentSessionHandoffPendingError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent session '${sessionId}' is moving to another server`);
    this.name = "AgentSessionHandoffPendingError";
  }
}

export class UnsupportedAgentTopologyError extends Error {
  constructor(readonly topology: string) {
    super(`Agent topology '${topology}' is not implemented by this host`);
    this.name = "UnsupportedAgentTopologyError";
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

/**
 * A mirror push found messages here the mirroring side doesn't know —
 * the session was continued on THIS backend, so the mirror source must
 * stop pushing (the conversation forked; this side owns it now).
 */
export class SessionMirrorDivergedError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Agent session '${sessionId}' was continued on this server; the mirror source must stop pushing`,
    );
    this.name = "SessionMirrorDivergedError";
  }
}

export { parsePorcelain, type SyncedFileChange } from "./sandbox-sync.js";

const tracer = getTracer("@catamorphic/core");

/** Shown in place of a turn that died with the process. */
export const INTERRUPTED_TURN_MESSAGE =
  "This response was interrupted before it finished. Send a new message to continue.";

/**
 * Author on turn-checkpoint commits — distinct from human commits and from
 * the system author used for generated-file syncs, so history reads honestly.
 */
const CHECKPOINT_AUTHOR = {
  name: "Catamorphic Agent",
  email: "agent@catamorphic.dev",
};

const SESSION_TASK_SUMMARY_LIMIT = 240;
const PEER_RECENT_WINDOW_MS = 30 * 60 * 1000;

/** Compact, bounded peer context derived from a session's latest request. */
export function summarizeSessionTask(message: string): string | null {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= SESSION_TASK_SUMMARY_LIMIT) return normalized;
  return `${normalized.slice(0, SESSION_TASK_SUMMARY_LIMIT - 1)}…`;
}

/** First line of the user's request, trimmed into a commit subject. */
function checkpointMessage(userMessage: string): string {
  const firstLine = userMessage.split("\n", 1)[0]?.trim() ?? "";
  const subject =
    firstLine.length > 68 ? `${firstLine.slice(0, 67).trimEnd()}…` : firstLine;
  return subject ? `Agent: ${subject}` : "Agent checkpoint";
}

/**
 * The framework's default standing prompt for coding-agent sessions. Hosts
 * replace it (or drop it) with `CatamorphicCoreConfig.standingAgentPrompt`
 * (ADR 0049).
 */
const WORKFLOW_AUTHORING_SYSTEM_PROMPT = `A Catamorphic project is a folder that can hold any kind of work — documents, notes, data, code, automations (workflows), and apps, in any mix. Read what is actually in the project before assuming what it is about; many projects contain no workflows at all. The rules below apply only when you create or edit workflows: Every workflow is an exported defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps })) value; runs execute ordered boundary and batch scopes against an immutable deployment, with continuation state persisted in Postgres. There is no "use workflow" directive — IO and business operations live in "use step" functions called from boundary run bodies. Cancellation is a host-issued terminal control declared with controls: { cancel: true }, never a BoundaryContext transition. A workflow may subscribe to host-defined trigger kinds with triggers: [trigger("kind", config)] — the kind name must be a string literal, the config a constant expression, both typed by the generated workflows/src/catamorphic-triggers.d.ts; the fired payload becomes the first step's input. Declare provider-neutral connections at workflow definition level; roles separately grant workflow, agent, Environment, and connection aliases, and each member explicitly enables unattended execution. Use context.host["catamorphic.sessions"].wake with a stable key and project-agent slug when a member-owned workflow should run an agent and surface its reusable session in desktop and PWA; service-owned enablements cannot create personal notifications. Only exported defineBatchStep calls inside defineBatch.process are physically coalesced. For authoring primitives, use the project's established SaaS wrapper when present; otherwise use @catamorphic/workflow. Never create local copies. Consult .agents/skills/writing-workflows/SKILL.md, .agents/skills/durable-workflows/SKILL.md, and .agents/skills/batch-workflows/SKILL.md, when present, before creating or restructuring workflows.`;

export function buildAgentSystemPrompt({
  systemPrompt,
  standingPrompt,
}: {
  systemPrompt?: string;
  /**
   * The host-resolved standing prompt: `undefined` = the framework default,
   * a string = the host's replacement, `false` = none (ADR 0049).
   */
  standingPrompt?: string | false;
}): string {
  const standing =
    standingPrompt === undefined
      ? WORKFLOW_AUTHORING_SYSTEM_PROMPT
      : standingPrompt;
  return [standing, systemPrompt]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n\n");
}

export async function ensureBatchWorkflowSkill({
  sandboxProvider,
  sandboxProviderId,
  projectDir,
  seedFiles,
}: {
  sandboxProvider: Pick<SandboxProvider, "executeCommand" | "uploadFiles">;
  sandboxProviderId: string;
  projectDir: string;
  /** The host-resolved seed set (ADR 0049); defaults to `SEED_SKILLS`. */
  seedFiles?: Record<string, string>;
}): Promise<boolean> {
  return ensureWorkflowSkill({
    sandboxProvider,
    sandboxProviderId,
    projectDir,
    seedFiles,
    skillPath: BATCH_WORKFLOW_SKILL_PATH,
  });
}

export async function ensureDurableWorkflowSkill({
  sandboxProvider,
  sandboxProviderId,
  projectDir,
  seedFiles,
}: {
  sandboxProvider: Pick<SandboxProvider, "executeCommand" | "uploadFiles">;
  sandboxProviderId: string;
  projectDir: string;
  /** The host-resolved seed set (ADR 0049); defaults to `SEED_SKILLS`. */
  seedFiles?: Record<string, string>;
}): Promise<boolean> {
  return ensureWorkflowSkill({
    sandboxProvider,
    sandboxProviderId,
    projectDir,
    seedFiles,
    skillPath: DURABLE_WORKFLOW_SKILL_PATH,
  });
}

async function ensureWorkflowSkill({
  sandboxProvider,
  sandboxProviderId,
  projectDir,
  skillPath,
  seedFiles,
}: {
  sandboxProvider: Pick<SandboxProvider, "executeCommand" | "uploadFiles">;
  sandboxProviderId: string;
  projectDir: string;
  skillPath: string;
  seedFiles?: Record<string, string>;
}): Promise<boolean> {
  // Restore from the HOST-RESOLVED seed set, never the hardcoded defaults:
  // an embedder that removed a workflow skill from its seeds must not have
  // it resurrect in projects (ADR 0049).
  const content = (seedFiles ?? SEED_SKILLS)[skillPath];
  if (content === undefined) return false;

  // Only projects with a workflows workspace get the skill restored — a
  // docs-only project that deleted it must not have it resurrect (ADR 0043).
  const workspace = await sandboxProvider.executeCommand(
    sandboxProviderId,
    `test -f ${shellQuote(`${projectDir}/workflows/package.json`)}`,
  );
  if (workspace.exitCode !== 0) return false;

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
  /** Present only when a workflow asked the host to surface this turn. */
  notification?: { title?: string; body?: string };
  changedFiles: string[];
  /** Checkout in which this turn ran. Host-local and never persisted. */
  workingDirectory: string;
}

export interface NativeAgentCheckout {
  resolve(input: {
    projectId: string;
    sessionId: string;
  }): Promise<string | undefined> | string | undefined;
  checkpoint?(input: {
    projectId: string;
    sessionId: string;
    workingDirectory: string;
    message: string;
  }): Promise<string | null>;
}

interface AgentSessionsDeps {
  /** Stable, host-owned identity used to fence cross-host session delivery. */
  hostId: string;
  /** Source-host presence window before a mirrored session is shown paused. */
  authorityLeaseMs?: number;
  projectManager: ProjectManager;
  sandboxProvider: SandboxProvider;
  codingAgents: CodingAgentRegistry;
  devSandboxes: DevSandboxService;
  /**
   * Resolve a project's directory on the WorkerNode filesystem, for `native`
   * topology agents (Claude Code, Codex, runtimes that operate on
   * local paths). Hosts that only register sandbox agents can omit it.
   */
  nativeAgentCheckout?: NativeAgentCheckout;
  executionEnvironments: ExecutionEnvironmentsService;
  executionAllocations: ExecutionAllocationsService;
  connectionAdmission?: ConnectionAdmissionService;
  connectionGrants?: ConnectionCapabilityGrantsService;
  connectionMcpUrl?: (args: {
    projectId: string;
    sessionId: string;
    alias: string;
  }) => string | undefined;
  plugins?: PluginsService;
  pluginResolver?: PluginResolver;
  /**
   * Fires after a turn's settled state is durably recorded. Host-owned:
   * exceptions are swallowed, and the turn's response never waits on it.
   */
  onTurnSettled?: (event: AgentTurnSettledEvent) => void | Promise<void>;
  /**
   * The host-resolved per-project seed files (ADR 0049); the workflow-skill
   * restore reads from this set, so a seed the host removed never
   * resurrects. Defaults to the framework's `SEED_SKILLS`.
   */
  seedFiles?: Record<string, string>;
  /**
   * The host's standing agent prompt: `undefined` = framework default,
   * string = replacement, `false` = none (ADR 0049).
   */
  standingAgentPrompt?: string | false;
  /**
   * The project's MCP tool roster (tool name → workflow name) at its
   * production commit — how a scoped caller's workflow refs become a
   * tool-policy layer on the project's tools server (ADR 0055).
   */
  mcpToolNames?: (
    identity: Identity,
    projectId: string,
  ) => Promise<ReadonlyMap<string, string>>;
  /** Tenant app policy, for scope resolution (app refs). */
  appPolicies?: AppPoliciesService;
  /**
   * The documents surface. When present, `store/` in the caller's working
   * copy is pulled before each turn and shipped after it AS THE CALLER
   * (ADR 0055): a member's agent writing `store/customers/acme/notes.md`
   * lands it in the store with the right author, and never anything the
   * member may not write. Hosts whose working copies are the truth (the
   * desktop's local projects) leave it unset.
   */
  storeSync?: { documents: DocumentsService };
}

/**
 * Orchestrates coding-agent sessions across the host's registry of agents:
 *
 * 1. Sessions are created lazily — the row exists immediately, and the
 *    provider session (plus, for sandbox agents, the per-(project, user)
 *    dev sandbox) is anchored on the first turn. Switching a session to a
 *    different agent just clears the anchor; the next turn re-anchors.
 * 2. `controller` agents run against the dev sandbox and their changes sync
 *    back into the user's dev working copy as an uncommitted draft.
 *    `native` agents run directly in the project's WorkerNode directory. Their
 *    edits land in place, so no sync step and no draft.
 * 3. The conversation persists to `agent_sessions` / `agent_messages`.
 */
export class AgentSessionsService {
  readonly turns: AgentTurnsService;
  readonly mailboxes: SessionMailboxesService;
  readonly hostId: string;
  readonly authorityLeaseMs: number;
  private readonly projectManager: ProjectManager;
  private readonly sandboxProvider: SandboxProvider;
  private readonly codingAgents: CodingAgentRegistry;
  private readonly nativeAgentCheckout?: NativeAgentCheckout;
  private readonly executionEnvironments: ExecutionEnvironmentsService;
  private readonly executionAllocations: ExecutionAllocationsService;
  private readonly connectionAdmission?: ConnectionAdmissionService;
  private readonly connectionGrants?: ConnectionCapabilityGrantsService;
  private readonly connectionMcpUrl?: AgentSessionsDeps["connectionMcpUrl"];
  private readonly plugins?: PluginsService;
  private readonly pluginResolver?: PluginResolver;
  private readonly devSandboxes: DevSandboxService;
  private readonly onTurnSettled?: AgentSessionsDeps["onTurnSettled"];
  private readonly seedFiles?: Record<string, string>;
  private readonly standingAgentPrompt?: string | false;
  private readonly mcpToolNames?: AgentSessionsDeps["mcpToolNames"];
  private readonly appPolicies?: AppPoliciesService;
  private readonly storeSync?: AgentSessionsDeps["storeSync"];
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
  private readonly drainers = new Map<string, Promise<void>>();
  private readonly turnWorkerId = `agent-sessions:${randomUUID()}`;

  constructor(
    private readonly db: Kysely<DB>,
    deps: AgentSessionsDeps,
  ) {
    this.turns = new AgentTurnsService(db);
    this.hostId = deps.hostId;
    this.authorityLeaseMs = deps.authorityLeaseMs ?? 90_000;
    this.mailboxes = new SessionMailboxesService(db, deps.hostId);
    this.projectManager = deps.projectManager;
    this.sandboxProvider = deps.sandboxProvider;
    this.codingAgents = deps.codingAgents;
    this.nativeAgentCheckout = deps.nativeAgentCheckout;
    this.executionEnvironments = deps.executionEnvironments;
    this.executionAllocations = deps.executionAllocations;
    this.connectionAdmission = deps.connectionAdmission;
    this.connectionGrants = deps.connectionGrants;
    this.connectionMcpUrl = deps.connectionMcpUrl;
    this.devSandboxes = deps.devSandboxes;
    this.plugins = deps.plugins;
    this.pluginResolver = deps.pluginResolver;
    this.onTurnSettled = deps.onTurnSettled;
    this.seedFiles = deps.seedFiles;
    this.standingAgentPrompt = deps.standingAgentPrompt;
    this.mcpToolNames = deps.mcpToolNames;
    this.appPolicies = deps.appPolicies;
    this.storeSync = deps.storeSync;
  }

  async list(
    identity: Identity,
    projectId: string,
    input: { limit?: number; offset?: number } = {},
  ): Promise<{ items: AgentSession[]; total: number }> {
    await this.requireProject(identity, projectId);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    // A viewer sees only its own conversations, on agents its scope still
    // covers (a revoked agent's sessions vanish from the list too).
    let query = this.db
      .selectFrom("agent_sessions")
      .where("project_id", "=", projectId);
    if (!isBuilder(identity, projectId)) {
      const agentIds = this.coveredAgentIds(identity, projectId);
      if (agentIds.length === 0) return { items: [], total: 0 };
      query = query
        .where("external_user_id", "=", identity.externalUserId)
        .where("agent_id", "in", agentIds);
    }

    const rows = await query
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    const total = await query
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.count));

    return {
      items: rows.map((row) =>
        mapSession(
          row,
          this.runningTurns.has(row.id),
          this.hostId,
          this.authorityLeaseMs,
        ),
      ),
      total,
    };
  }

  /**
   * Other visible conversations in this project for agent coordination.
   * Unlike the normal personal-session list, scoped callers may see peers
   * running an agent ref their scope covers. The project boundary and agent
   * scope remain hard authorization boundaries.
   */
  async listPeers(
    identity: Identity,
    projectId: string,
    ownSessionId: string,
  ): Promise<AgentSessionPeer[]> {
    await this.requireSession(identity, projectId, ownSessionId);
    let query = this.db
      .selectFrom("agent_sessions")
      .where("project_id", "=", projectId)
      .where("id", "!=", ownSessionId)
      .where("status", "=", "active");
    if (!isBuilder(identity, projectId)) {
      const agentIds = this.coveredAgentIds(identity, projectId);
      if (agentIds.length === 0) return [];
      query = query.where("agent_id", "in", agentIds);
    }
    const runningIds = [...this.runningTurns.keys()];
    const recentSince = new Date(Date.now() - PEER_RECENT_WINDOW_MS);
    query = query.where((expression) =>
      runningIds.length > 0
        ? expression.or([
            expression("updated_at", ">=", recentSince),
            expression("id", "in", runningIds),
          ])
        : expression("updated_at", ">=", recentSince),
    );
    const rows = await query
      .selectAll()
      .orderBy("updated_at", "desc")
      .limit(20)
      .execute();
    if (rows.length === 0) return [];

    const latestRequests = await this.db
      .selectFrom("agent_messages")
      .where(
        "session_id",
        "in",
        rows.map((row) => row.id),
      )
      .where("role", "=", "user")
      .select(["session_id", "content", "seq"])
      .distinctOn("session_id")
      .orderBy("session_id")
      .orderBy("seq", "desc")
      .execute();
    const taskBySession = new Map<string, string | null>();
    for (const message of latestRequests) {
      if (!taskBySession.has(message.session_id)) {
        taskBySession.set(
          message.session_id,
          summarizeSessionTask(message.content),
        );
      }
    }

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      agentId: row.agent_id,
      running: this.runningTurns.has(row.id),
      task: taskBySession.get(row.id) ?? null,
      activity: row.activity,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async setActivity(
    identity: Identity,
    projectId: string,
    sessionId: string,
    activity: string | null,
  ): Promise<void> {
    await this.requireSession(identity, projectId, sessionId);
    const normalized = activity?.replace(/\s+/g, " ").trim() || null;
    if (normalized && normalized.length > 500) {
      throw new Error("Session activity must be 500 characters or fewer");
    }
    await this.db
      .updateTable("agent_sessions")
      .set({ activity: normalized, updated_at: new Date() })
      .where("id", "=", sessionId)
      .execute();
  }

  /**
   * Atomically replace a session's agent-owned progress list. Deliberately
   * absent from the public HTTP routes: hosts expose this only through a
   * trusted, session-bound agent tool, while clients receive read-only state.
   */
  async replaceTodos(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: readonly AgentTodoInput[],
  ): Promise<AgentTodo[]> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (input.length > 50) {
      throw new Error("A todo list can contain at most 50 items");
    }
    const existing = agentTodos(session.todos);
    const existingIds = new Set(existing.map((item) => item.id));
    const usedIds = new Set<string>();
    const todos = input.map((item) => {
      const title = item.title.replace(/\s+/g, " ").trim();
      const description = item.description.trim();
      if (!title) throw new Error("Every todo needs a title");
      if (title.length > 200) {
        throw new Error("Todo titles must be 200 characters or fewer");
      }
      if (!description) throw new Error("Every todo needs a description");
      if (description.length > 4_000) {
        throw new Error("Todo descriptions must be 4,000 characters or fewer");
      }
      if (
        item.status !== "pending" &&
        item.status !== "in_progress" &&
        item.status !== "completed"
      ) {
        throw new Error(`Unknown todo status: ${String(item.status)}`);
      }
      const requestedId = item.id?.trim();
      if (requestedId && !existingIds.has(requestedId)) {
        throw new Error(`Todo '${requestedId}' does not exist in this session`);
      }
      const id = requestedId || randomUUID();
      if (usedIds.has(id)) throw new Error(`Duplicate todo id: ${id}`);
      usedIds.add(id);
      return { id, title, description, status: item.status };
    });
    await this.db
      .updateTable("agent_sessions")
      .set({
        todos: agentTodosJson(todos),
        updated_at: new Date(),
      })
      .where("id", "=", sessionId)
      .execute();
    return todos;
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
    return {
      ...mapSession(
        row,
        this.runningTurns.has(row.id),
        this.hostId,
        this.authorityLeaseMs,
      ),
      messages: settled.map(mapMessage),
      pendingTurns: await this.turns.listPendingMessages({ sessionId }),
    };
  }

  async updateQueuedTurn(
    identity: Identity,
    projectId: string,
    sessionId: string,
    turnId: string,
    input: { content?: string; metadata?: JsonObject; held?: boolean },
  ): Promise<boolean> {
    await this.requireSession(identity, projectId, sessionId);
    const updated = await this.turns.updateQueued({
      turnId,
      sessionId,
      ...input,
    });
    if (updated && input.held === false) {
      void this.scheduleDrain(identity, projectId, sessionId).catch(() => {});
    }
    return updated;
  }

  async cancelQueuedTurn(
    identity: Identity,
    projectId: string,
    sessionId: string,
    turnId: string,
  ): Promise<boolean> {
    await this.requireSession(identity, projectId, sessionId);
    return this.turns.cancelQueued({ turnId, sessionId });
  }

  async promoteQueuedTurn(
    identity: Identity,
    projectId: string,
    sessionId: string,
    turnId: string,
  ): Promise<boolean> {
    await this.requireSession(identity, projectId, sessionId);
    const promoted = await this.turns.promoteQueued({ turnId, sessionId });
    if (!promoted) return false;
    await this.interrupt(identity, projectId, sessionId);
    void this.scheduleDrain(identity, projectId, sessionId).catch(() => {});
    return true;
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

    await this.db
      .updateTable("agent_turns")
      .set({
        status: "failed",
        error: "The host stopped while this turn was running",
        completed_at: new Date(),
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("session_id", "=", sessionId)
      .where("status", "=", "running")
      .where("lease_owner", "!=", this.turnWorkerId)
      .execute();

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
      environment?: string;
      source?: AgentSessionSource;
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
    input: {
      systemPrompt?: string;
      agentId?: string;
      effort?: AgentEffort;
      environment?: string;
      title?: string;
      wakeKey?: string;
      source?: AgentSessionSource;
    },
  ): Promise<AgentSession> {
    await this.requireProject(identity, projectId);
    this.assertAgentAccess(identity, projectId, input.agentId ?? null);
    // Validate up front so a bad agent id fails at create, not first send.
    const agent = this.resolveAgent(input.agentId ?? null, projectId);
    const sessionId = randomUUID();
    const admitted = await this.executionEnvironments.admit({
      identity,
      projectId,
      environment: input.environment,
      allowed: agent.environment?.allowed,
      preferred: agent.environment?.preferred,
      requirements: {
        ...agent.environment?.requirements,
        workload: "agent",
        topology: agent.topology,
      },
    });
    const requirements = agent.connectionRequirements ?? [];
    if (requirements.length > 0 && !this.connectionAdmission) {
      throw new Error("Connection providers are not configured");
    }
    const connections =
      requirements.length > 0
        ? await this.connectionAdmission!.admit({
            identity,
            projectId,
            environment: admitted.environmentName,
            requirements,
          })
        : [];

    const row = await this.db.transaction().execute(async (transaction) => {
      const allocation = await this.executionAllocations.create({
        identity,
        projectId,
        environmentName: admitted.environmentName,
        workloadKind: "agent",
        rootWorkloadId: sessionId,
        policy: {
          binding: admitted.binding,
          requirements: admitted.effectiveRequirements,
          connections,
        },
        transaction,
      });
      return transaction
        .insertInto("agent_sessions")
        .values({
          id: sessionId,
          project_id: projectId,
          external_user_id: identity.externalUserId,
          provider: agent.provider.name,
          source: input.source ?? "api",
          provider_session_id: null,
          agent_id: input.agentId ?? null,
          model_effort: input.effort ?? null,
          system_prompt: input.systemPrompt ?? null,
          sandbox_id: null,
          allocation_id: allocation.id,
          environment_name: admitted.environmentName,
          status: "active",
          title: input.title ?? null,
          wake_key: input.wakeKey ?? null,
          base_commit_sha: null,
          authority_host_id: this.hostId,
          authority_revision: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
  }

  /**
   * Create or reuse one stable session for a workflow and queue a turn in it.
   * The queued message asks clients to surface the session only after the turn
   * settles, so a scheduled agent never steals focus while it is working.
   */
  async wake(
    identity: Identity,
    projectId: string,
    input: {
      wakeKey: string;
      content: string;
      workflowName: string;
      runId: string;
      agentSlug?: string;
      environment?: string;
      title?: string;
      mode?: "next_turn" | "interrupt";
      notification?: { title?: string; body?: string };
    },
  ): Promise<AgentSessionWakeReceipt> {
    await this.requireProject(identity, projectId);
    const agentId = input.agentSlug
      ? formatProjectAgentId(projectId, input.agentSlug)
      : null;
    const findExisting = () =>
      this.db
        .selectFrom("agent_sessions")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("external_user_id", "=", identity.externalUserId)
        .where("wake_key", "=", input.wakeKey)
        .where("status", "=", "active")
        .executeTakeFirst();

    let row = await findExisting();
    let sessionCreated = false;
    if (!row) {
      try {
        const created = await this.createInner(identity, projectId, {
          ...(agentId ? { agentId } : {}),
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.title ? { title: input.title } : {}),
          wakeKey: input.wakeKey,
        });
        row = await this.db
          .selectFrom("agent_sessions")
          .selectAll()
          .where("id", "=", created.id)
          .executeTakeFirstOrThrow();
        sessionCreated = true;
      } catch (error) {
        // Concurrent retries may race the partial unique wake-key index. The
        // winning session is the one both calls must use; any other failure
        // remains visible.
        row = await findExisting();
        if (!row) throw error;
      }
    }
    await this.requireSession(identity, projectId, row.id);
    if (agentId && row.agent_id !== agentId) {
      throw new Error(
        `Wake key '${input.wakeKey}' already belongs to a different agent`,
      );
    }
    const receipt = await this.deliver(identity, projectId, row.id, {
      content: input.content,
      author: {
        kind: "workflow",
        runId: input.runId,
        workflowName: input.workflowName,
      },
      mode: input.mode ?? "next_turn",
      idempotencyKey: `workflow-wake:${input.runId}:${input.wakeKey}`,
      metadata: {
        workflowNotification: {
          ...(input.notification?.title
            ? { title: input.notification.title }
            : {}),
          ...(input.notification?.body
            ? { body: input.notification.body }
            : {}),
        },
      },
    });
    return { ...receipt, sessionId: row.id, sessionCreated };
  }

  /** Acknowledgement-by-interaction shared by desktop and PWA clients. */
  async acknowledgeAttention(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<AgentSession> {
    await this.requireSession(identity, projectId, sessionId);
    const row = await this.db
      .updateTable("agent_sessions")
      .set(({ ref }) => ({
        attention_seen_revision: ref("attention_revision"),
      }))
      .where("id", "=", sessionId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSession(
      row,
      this.runningTurns.has(sessionId),
      this.hostId,
      this.authorityLeaseMs,
    );
  }

  /**
   * Mirror a session from another backend (a desktop pushing its local
   * transcript to the server it's linked to, ADR 0061): upsert the
   * session under the CALLER's identity with THIS registry's default
   * agent, and append the messages this side doesn't have yet.
   * Idempotent by message id. The provider anchor stays null, so a later
   * sendMessage here re-anchors with the mirrored transcript as history —
   * that IS the "continue on the server" path. If this side already holds
   * messages the payload doesn't (someone continued here), the mirror is
   * refused with {@link SessionMirrorDivergedError}: the fork's owner is
   * now this backend.
   */
  async mirror(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: {
      title?: string | null;
      icon?: string | null;
      provider?: string;
      source?: AgentSessionSource;
      /**
       * The source session's PROJECT-agent slug, when it ran one: project
       * agent definitions are committed files that sync between backends,
       * so when this side has the same slug (and the caller's scope covers
       * it), the fork continues on the SAME agent instead of the default.
       */
      agentSlug?: string;
      todos: AgentTodo[];
      authority: { hostId: string; revision: number };
      messages: Array<{
        id: string;
        role: "user" | "assistant" | "system";
        content: string;
        metadata: Record<string, unknown> | null;
        author: SessionMessageAuthor;
        deliveryMode: SessionDeliveryMode;
        idempotencyKey: string | null;
        createdAt: string;
      }>;
    },
  ): Promise<AgentSession> {
    return withSpan(
      {
        tracer,
        name: "agent.session.mirror",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.session.id": sessionId,
        },
      },
      async () => {
        await this.requireProject(identity, projectId);
        const agentId = this.mirrorAgentId(
          identity,
          projectId,
          input.agentSlug,
        );
        this.assertAgentAccess(identity, projectId, agentId);

        const existing = await this.db
          .selectFrom("agent_sessions")
          .selectAll()
          .where("id", "=", sessionId)
          .executeTakeFirst();
        if (
          existing &&
          (existing.project_id !== projectId ||
            existing.external_user_id !== identity.externalUserId)
        ) {
          throw new AccessDeniedError();
        }
        if (existing && this.runningTurns.has(sessionId)) {
          throw new AgentTurnInProgressError(sessionId);
        }
        if (
          existing &&
          existing.authority_host_id !== "unassigned" &&
          (existing.authority_host_id !== input.authority.hostId ||
            Number(existing.authority_revision) > input.authority.revision)
        ) {
          throw new SessionMirrorDivergedError(sessionId);
        }
        if (existing && !existing.allocation_id) {
          throw new Error("Agent session has no Environment Allocation");
        }
        const mirrorAgent = existing
          ? undefined
          : this.resolveAgent(agentId, projectId);
        const mirrorAdmission = mirrorAgent
          ? await this.executionEnvironments.admit({
              identity,
              projectId,
              allowed: mirrorAgent.environment?.allowed,
              preferred: mirrorAgent.environment?.preferred,
              requirements: {
                ...mirrorAgent.environment?.requirements,
                workload: "agent",
                topology: mirrorAgent.topology,
              },
            })
          : undefined;
        const mirrorRequirements = mirrorAgent?.connectionRequirements ?? [];
        if (mirrorRequirements.length > 0 && !this.connectionAdmission) {
          throw new Error("Connection providers are not configured");
        }
        const mirrorConnections = mirrorAdmission
          ? mirrorRequirements.length > 0
            ? await this.connectionAdmission!.admit({
                identity,
                projectId,
                environment: mirrorAdmission.environmentName,
                requirements: mirrorRequirements,
              })
            : []
          : undefined;

        // One transaction: the divergence check, the session upsert, and
        // the appends must not interleave with a turn starting here (the
        // append order IS the transcript order, via `seq`).
        const row = await this.db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom("agent_sessions")
            .selectAll()
            .where("id", "=", sessionId)
            .forUpdate()
            .executeTakeFirst();
          if (
            current &&
            (current.project_id !== projectId ||
              current.external_user_id !== identity.externalUserId)
          ) {
            throw new AccessDeniedError();
          }
          if (
            current &&
            current.authority_host_id !== "unassigned" &&
            (current.authority_host_id !== input.authority.hostId ||
              Number(current.authority_revision) > input.authority.revision)
          ) {
            throw new SessionMirrorDivergedError(sessionId);
          }
          if (current && !current.allocation_id) {
            throw new Error("Agent session has no Environment Allocation");
          }
          const held = await trx
            .selectFrom("agent_messages")
            .select(["id"])
            .where("session_id", "=", sessionId)
            .forUpdate()
            .execute();
          const incomingIds = new Set(input.messages.map((m) => m.id));
          if (held.some((entry) => !incomingIds.has(entry.id))) {
            throw new SessionMirrorDivergedError(sessionId);
          }

          const allocation =
            !current && mirrorAdmission
              ? await this.executionAllocations.create({
                  identity,
                  projectId,
                  environmentName: mirrorAdmission.environmentName,
                  workloadKind: "agent",
                  rootWorkloadId: sessionId,
                  policy: {
                    binding: mirrorAdmission.binding,
                    requirements: mirrorAdmission.effectiveRequirements,
                    connections: mirrorConnections,
                  },
                  transaction: trx,
                })
              : undefined;
          const session = current
            ? await trx
                .updateTable("agent_sessions")
                .set({
                  title: input.title ?? current.title,
                  icon: input.icon ?? current.icon,
                  todos: agentTodosJson(input.todos),
                  updated_at: new Date(),
                  authority_host_id: input.authority.hostId,
                  authority_revision: input.authority.revision,
                  authority_seen_at: new Date(),
                  mirror_message_count: input.messages.length,
                })
                .where("id", "=", sessionId)
                .returningAll()
                .executeTakeFirstOrThrow()
            : await trx
                .insertInto("agent_sessions")
                .values({
                  id: sessionId,
                  project_id: projectId,
                  external_user_id: identity.externalUserId,
                  provider: input.provider ?? "mirror",
                  source: input.source ?? "api",
                  provider_session_id: null,
                  agent_id: agentId,
                  model_effort: null,
                  system_prompt: null,
                  sandbox_id: null,
                  allocation_id: allocation!.id,
                  environment_name: mirrorAdmission!.environmentName,
                  status: "active",
                  base_commit_sha: null,
                  title: input.title ?? null,
                  icon: input.icon ?? null,
                  todos: agentTodosJson(input.todos),
                  authority_host_id: input.authority.hostId,
                  authority_revision: input.authority.revision,
                  authority_seen_at: new Date(),
                  mirror_message_count: input.messages.length,
                })
                .returningAll()
                .executeTakeFirstOrThrow();

          // `seq` is an identity column: transcript order IS insertion
          // order, so append the unseen messages in payload order, in one
          // statement (a mirror can carry hundreds of messages).
          const heldIds = new Set(held.map((entry) => entry.id));
          const fresh = input.messages
            .filter((message) => !heldIds.has(message.id))
            .map((message) => ({
              id: message.id,
              session_id: sessionId,
              role: message.role,
              content: message.content,
              metadata: message.metadata as JsonObject | null,
              author_kind: message.author.kind,
              author_payload: JSON.parse(JSON.stringify(message.author)),
              delivery_mode: message.deliveryMode,
              idempotency_key: message.idempotencyKey,
              commit_sha: null,
              created_at: new Date(message.createdAt),
            }));
          if (fresh.length > 0) {
            await trx.insertInto("agent_messages").values(fresh).execute();
          }
          return session;
        });
        return mapSession(row, false, this.hostId, this.authorityLeaseMs);
      },
    );
  }

  /** The agent a mirrored session lands on: the source's project-agent
   * slug when this registry has it AND the caller may use it, else the
   * registry default. */
  private mirrorAgentId(
    identity: Identity,
    projectId: string,
    agentSlug: string | undefined,
  ): string | null {
    if (agentSlug) {
      const preferred = formatProjectAgentId(projectId, agentSlug);
      const usable =
        this.codingAgents.get(preferred) !== undefined &&
        (isBuilder(identity, projectId) ||
          this.coveringAgentRef(identity, projectId, preferred) !== undefined);
      if (usable) return preferred;
    }
    return this.codingAgents.defaultAgentId(projectId) ?? null;
  }

  /**
   * The mirror source's side of a fork (ADR 0062): once the remote
   * reported divergence, stamp the LOCAL copy with a visible system
   * marker naming where the conversation went. Idempotent — one marker
   * per session, however many times the 409 is re-learned.
   */
  async recordMirrorFork(
    identity: Identity,
    projectId: string,
    sessionId: string,
    fork: { serverUrl: string; remoteProjectId: string },
  ): Promise<void> {
    await this.requireSession(identity, projectId, sessionId);
    const existing = await this.db
      .selectFrom("agent_messages")
      .select(["metadata"])
      .where("session_id", "=", sessionId)
      .where("role", "=", "system")
      .execute();
    const already = existing.some((row) => {
      const marker = (row.metadata as { marker?: { kind?: string } } | null)
        ?.marker;
      return marker?.kind === "mirror_fork";
    });
    if (already) return;
    const host = hostOf(fork.serverUrl);
    await this.db
      .insertInto("agent_messages")
      .values({
        session_id: sessionId,
        role: "system",
        content: `Continued on ${host}. This copy is history now.`,
        author_kind: "system",
        author_payload: { kind: "system", code: "mirror_fork" },
        delivery_mode: "message_only",
        metadata: {
          marker: {
            kind: "mirror_fork",
            serverUrl: fork.serverUrl,
            remoteProjectId: fork.remoteProjectId,
            sessionId,
          },
        },
      })
      .execute();
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
    patch: {
      agentId?: string;
      effort?: AgentEffort | null;
      environment?: string;
    },
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
      allocation_id: string;
      environment_name: string;
      sandbox_id: null;
    }> = {};
    let reallocatedRow: SessionRow | undefined;

    if (patch.agentId !== undefined && patch.agentId !== session.agent_id) {
      this.assertAgentAccess(identity, projectId, patch.agentId);
      const agent = this.codingAgents.get(patch.agentId);
      if (!agent) throw new AgentNotConfiguredError(patch.agentId);
      // Let the outgoing provider release its in-memory state.
      if (session.provider_session_id) {
        const previous = this.codingAgents.get(
          session.agent_id ?? this.codingAgents.defaultAgentId(projectId) ?? "",
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
    if (patch.environment !== undefined || updates.agent_id !== undefined) {
      const previousAllocationId = session.allocation_id;
      if (!previousAllocationId) {
        throw new Error("Agent session has no Environment Allocation");
      }
      const nextAgent = this.resolveAgent(
        patch.agentId ?? session.agent_id,
        projectId,
      );
      const admission = await this.executionEnvironments.admit({
        identity,
        projectId,
        environment: patch.environment ?? session.environment_name ?? undefined,
        allowed: nextAgent.environment?.allowed,
        preferred: nextAgent.environment?.preferred,
        requirements: {
          ...nextAgent.environment?.requirements,
          workload: "agent",
          topology: nextAgent.topology,
        },
      });
      const requirements = nextAgent.connectionRequirements ?? [];
      if (requirements.length > 0 && !this.connectionAdmission) {
        throw new Error("Connection providers are not configured");
      }
      const connections =
        requirements.length > 0
          ? await this.connectionAdmission!.admit({
              identity,
              projectId,
              environment: admission.environmentName,
              requirements,
            })
          : [];
      reallocatedRow = await this.db
        .transaction()
        .execute(async (transaction) => {
          await this.executionAllocations.release({
            identity,
            allocationId: previousAllocationId,
            transaction,
          });
          const allocation = await this.executionAllocations.create({
            identity,
            projectId,
            environmentName: admission.environmentName,
            workloadKind: "agent",
            rootWorkloadId: sessionId,
            policy: {
              binding: admission.binding,
              requirements: admission.effectiveRequirements,
              connections,
            },
            transaction,
          });
          updates.allocation_id = allocation.id;
          updates.environment_name = admission.environmentName;
          updates.provider_session_id = null;
          updates.sandbox_id = null;
          return transaction
            .updateTable("agent_sessions")
            .set({ ...updates, updated_at: new Date() })
            .where("id", "=", sessionId)
            .returningAll()
            .executeTakeFirstOrThrow();
        });
      await this.connectionGrants?.revokeAllocation({
        allocationId: previousAllocationId,
      });
    }

    if (Object.keys(updates).length === 0)
      return mapSession(session, false, this.hostId, this.authorityLeaseMs);

    const row =
      reallocatedRow ??
      (await this.db
        .updateTable("agent_sessions")
        .set({ ...updates, updated_at: new Date() })
        .where("id", "=", sessionId)
        .returningAll()
        .executeTakeFirstOrThrow());

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
          author_kind: "system",
          author_payload: { kind: "system", code: "session_configuration" },
          delivery_mode: "message_only",
          metadata: { marker: entry.marker },
        })
        .execute();
    }
    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
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
    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
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
          source: session.source,
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
          authority_host_id: this.hostId,
          authority_revision: 1,
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
            author_kind: message.author_kind,
            author_payload: message.author_payload,
            delivery_mode: message.delivery_mode,
            idempotency_key: message.idempotency_key,
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
          author_kind: "system",
          author_payload: { kind: "system", code: "session_fork" },
          delivery_mode: "message_only",
          metadata: {
            marker: { kind: "fork", parentSessionId: sessionId },
          },
        })
        .execute();
      return fork;
    });
    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
  }

  async sendMessage(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
    input: {
      attachments?: AgentAttachment[];
      deliveryMode?: Exclude<SessionDeliveryMode, "message_only">;
    } = {},
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
    input: {
      attachments?: AgentAttachment[];
      deliveryMode?: Exclude<SessionDeliveryMode, "message_only">;
    } = {},
  ): Promise<AgentMessage> {
    const receipt = await this.enqueueMessage(
      identity,
      projectId,
      sessionId,
      message,
      input,
    );
    if (!receipt.turnId) throw new Error("A queued send must create a turn");
    await this.scheduleDrain(identity, projectId, sessionId);
    const turn = await this.db
      .selectFrom("agent_turns")
      .innerJoin(
        "agent_messages",
        "agent_messages.id",
        "agent_turns.result_message_id",
      )
      .selectAll("agent_messages")
      .where("agent_turns.id", "=", receipt.turnId)
      .executeTakeFirstOrThrow();
    return mapMessage(turn);
  }

  /**
   * Accept a human message into the durable session inbox and return as soon
   * as it is persisted. Execution is owned by the session drainer, not the
   * HTTP request or renderer that submitted it.
   */
  async enqueueMessage(
    identity: Identity,
    projectId: string,
    sessionId: string,
    message: string,
    input: {
      attachments?: AgentAttachment[];
      deliveryMode?: Exclude<SessionDeliveryMode, "message_only">;
      idempotencyKey?: string;
    } = {},
  ): Promise<SessionDeliveryReceipt> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }
    if (session.handoff_status === "pending") {
      throw new AgentSessionHandoffPendingError(sessionId);
    }
    if (
      session.authority_host_id !== "unassigned" &&
      session.authority_host_id !== this.hostId
    ) {
      throw new AgentSessionAuthorityRequiredError(
        sessionId,
        session.authority_host_id,
        Number(session.authority_revision),
      );
    }
    await this.claimLocalAuthority(session);
    this.cancelAutoRetry(sessionId);
    if (input.deliveryMode === "interrupt") {
      await this.interrupt(identity, projectId, sessionId);
    }
    const receipt = await this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("agent_sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.status !== "active") {
        throw new AgentSessionClosedError(sessionId);
      }
      if (current.handoff_status === "pending") {
        throw new AgentSessionHandoffPendingError(sessionId);
      }
      if (current.authority_host_id !== this.hostId) {
        throw new AgentSessionAuthorityRequiredError(
          sessionId,
          current.authority_host_id,
          Number(current.authority_revision),
        );
      }
      return this.turns.deliver({
        sessionId,
        content: message,
        author: { kind: "user", externalUserId: identity.externalUserId },
        mode: input.deliveryMode ?? "next_turn",
        idempotencyKey: input.idempotencyKey,
        metadata: input.attachments?.length
          ? {
              attachments: JSON.parse(JSON.stringify(input.attachments)),
            }
          : undefined,
        transaction,
      });
    });
    if (!receipt.turnId) throw new Error("A queued send must create a turn");
    void this.scheduleDrain(identity, projectId, sessionId).catch(() => {
      // The accepted turn remains durably failed or queued for inspection.
    });
    return receipt;
  }

  /** Deliver an attributed inbox message and optionally schedule an agent turn. */
  async deliver(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: {
      content: string;
      author: SessionMessageAuthor;
      mode: SessionDeliveryMode;
      idempotencyKey?: string;
      metadata?: JsonObject;
    },
  ): Promise<SessionDeliveryReceipt> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }
    if (
      session.authority_host_id !== "unassigned" &&
      session.authority_host_id !== this.hostId
    ) {
      return this.mailboxes.enqueue(identity, projectId, sessionId, {
        destination: {
          hostId: session.authority_host_id,
          revision: Number(session.authority_revision),
        },
        ...input,
      });
    }
    if (input.mode === "interrupt") {
      await this.interrupt(identity, projectId, sessionId);
    }
    const receipt = await this.turns.deliver({ sessionId, ...input });
    if (receipt.turnId) {
      void this.scheduleDrain(identity, projectId, sessionId).catch(() => {
        // The durable row remains queued or failed and is visible to operators.
      });
    }
    return receipt;
  }

  /** Import one item fetched by this authoritative host, idempotently. */
  async importMailbox(
    identity: Identity,
    projectId: string,
    item: SessionMailboxItem,
  ): Promise<SessionDeliveryReceipt> {
    const session = await this.requireSession(
      identity,
      projectId,
      item.sessionId,
    );
    if (session.status !== "active") {
      throw new AgentSessionClosedError(item.sessionId);
    }
    if (
      session.authority_host_id !== this.hostId ||
      Number(session.authority_revision) !== item.authorityRevision ||
      item.destinationHostId !== this.hostId
    ) {
      throw new SessionMirrorDivergedError(item.sessionId);
    }
    if (item.mode === "interrupt") {
      await this.interrupt(identity, projectId, item.sessionId);
    }
    const receipt = await this.turns.deliver({
      sessionId: item.sessionId,
      content: item.content,
      author: item.author,
      mode: item.mode,
      idempotencyKey: `mailbox:${item.sourceHostId}:${item.id}`,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    });
    if (receipt.turnId) {
      void this.scheduleDrain(identity, projectId, item.sessionId).catch(
        () => {},
      );
    }
    return receipt;
  }

  /** Explicitly claim a mirrored session for this host with a fencing CAS. */
  async resume(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: { expectedAuthorityRevision: number },
  ): Promise<AgentSession> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.status !== "active") {
      throw new AgentSessionClosedError(sessionId);
    }
    if (session.authority_host_id === this.hostId) {
      return mapSession(session, false, this.hostId, this.authorityLeaseMs);
    }
    if (
      Number(session.authority_revision) !== input.expectedAuthorityRevision
    ) {
      throw new SessionMirrorDivergedError(sessionId);
    }
    await this.claimLocalAuthority(session);
    const claimed = await this.requireSession(identity, projectId, sessionId);
    return mapSession(claimed, false, this.hostId, this.authorityLeaseMs);
  }

  /** Persist the local send barrier before a coordinated desktop handoff. */
  async beginHandoff(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: { destinationHostId: string },
  ): Promise<AgentSession> {
    await this.requireSession(identity, projectId, sessionId);
    const row = await this.db.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("agent_sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (session.status !== "active") {
        throw new AgentSessionClosedError(sessionId);
      }
      if (session.authority_host_id !== this.hostId) {
        throw new AgentSessionAuthorityRequiredError(
          sessionId,
          session.authority_host_id,
          Number(session.authority_revision),
        );
      }
      if (this.runningTurns.has(sessionId)) {
        throw new AgentTurnInProgressError(sessionId);
      }
      const pending = await transaction
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", sessionId)
        .where("status", "in", ["queued", "held", "running"])
        .executeTakeFirst();
      if (pending) throw new AgentTurnInProgressError(sessionId);
      return transaction
        .updateTable("agent_sessions")
        .set({
          handoff_status: "pending",
          handoff_destination_host_id: input.destinationHostId,
          updated_at: new Date(),
        })
        .where("id", "=", sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
  }

  async cancelHandoff(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<AgentSession> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (session.handoff_status === "none") {
      return mapSession(session, false, this.hostId, this.authorityLeaseMs);
    }
    if (session.authority_host_id !== this.hostId) {
      throw new SessionMirrorDivergedError(sessionId);
    }
    const row = await this.db
      .updateTable("agent_sessions")
      .set({
        handoff_status: "none",
        handoff_destination_host_id: null,
        updated_at: new Date(),
      })
      .where("id", "=", session.id)
      .where("authority_host_id", "=", this.hostId)
      .where("authority_revision", "=", session.authority_revision)
      .where("handoff_status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new SessionMirrorDivergedError(sessionId);
    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
  }

  /** Record a successful remote claim; replay is idempotent after a crash. */
  async completeHandoff(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: { destinationHostId: string; authorityRevision: number },
  ): Promise<AgentSession> {
    const session = await this.requireSession(identity, projectId, sessionId);
    if (
      session.authority_host_id === input.destinationHostId &&
      Number(session.authority_revision) === input.authorityRevision
    ) {
      return mapSession(session, false, this.hostId, this.authorityLeaseMs);
    }
    if (
      session.handoff_status !== "pending" ||
      session.authority_host_id !== this.hostId ||
      input.authorityRevision <= Number(session.authority_revision)
    ) {
      throw new SessionMirrorDivergedError(sessionId);
    }
    const row = await this.db
      .updateTable("agent_sessions")
      .set({
        authority_host_id: input.destinationHostId,
        authority_revision: input.authorityRevision,
        authority_seen_at: new Date(),
        handoff_status: "none",
        handoff_destination_host_id: null,
        updated_at: new Date(),
      })
      .where("id", "=", session.id)
      .where("authority_host_id", "=", this.hostId)
      .where("authority_revision", "=", session.authority_revision)
      .where("handoff_status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new SessionMirrorDivergedError(sessionId);
    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
  }

  private async claimLocalAuthority(session: SessionRow): Promise<void> {
    if (session.authority_host_id === this.hostId) return;
    const claimed = await this.db
      .updateTable("agent_sessions")
      .set({
        authority_host_id: this.hostId,
        authority_revision:
          session.authority_host_id === "unassigned"
            ? Number(session.authority_revision)
            : Number(session.authority_revision) + 1,
        authority_seen_at: new Date(),
        handoff_status: "none",
        handoff_destination_host_id: null,
        updated_at: new Date(),
      })
      .where("id", "=", session.id)
      .where("authority_host_id", "=", session.authority_host_id)
      .where("authority_revision", "=", session.authority_revision)
      .returning("id")
      .executeTakeFirst();
    if (claimed) return;
    const current = await this.db
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", session.id)
      .executeTakeFirstOrThrow();
    if (current.authority_host_id === this.hostId) return;
    throw new SessionMirrorDivergedError(session.id);
  }

  private scheduleDrain(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    const previous = this.drainers.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.drainSession(identity, projectId, sessionId));
    this.drainers.set(sessionId, current);
    void current.finally(() => {
      if (this.drainers.get(sessionId) === current) {
        this.drainers.delete(sessionId);
      }
    });
    return current;
  }

  private async drainSession(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    await this.turns.requeueExpired();
    while (true) {
      const turn = await this.turns.claimNextForSession({
        workerId: this.turnWorkerId,
        sessionId,
      });
      if (!turn) return;
      if (!turn.leaseToken) throw new Error("Claimed turn has no lease token");
      const message = await this.turns.messageForTurn({ turnId: turn.id });
      const attachments = message.metadata?.attachments as
        | AgentAttachment[]
        | undefined;
      const session = await this.requireSession(identity, projectId, sessionId);
      this.runningTurns.add(sessionId);
      try {
        const result = await this.runTurn(
          identity,
          projectId,
          sessionId,
          modelVisibleDelivery(message.content, message.author),
          {
            session,
            attachments,
            persistedUserMessageId: turn.messageId,
            requestMetadata: message.metadata,
          },
        );
        await this.turns.complete({
          turnId: turn.id,
          leaseToken: turn.leaseToken,
          resultMessageId: result.id,
        });
      } catch (error) {
        await this.turns.fail({
          turnId: turn.id,
          leaseToken: turn.leaseToken,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        this.runningTurns.delete(sessionId);
      }
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
          requestMetadata: userMetadata,
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
        const agent = this.resolveAgent(session.agent_id, projectId);
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
      /** Durable inbox message already persisted by AgentTurnsService. */
      persistedUserMessageId?: string;
      /** Metadata on the request that caused this turn. */
      requestMetadata?: JsonObject | null;
    },
  ): Promise<AgentMessage> {
    // Note: no stale-flag clearing needed here — interrupt() only sets the
    // flag while a turn is marked running, and every turn consumes it on
    // the way out (success and error paths both delete).
    const { session } = extras;
    const agent = this.resolveAgent(session.agent_id, projectId);
    const attachments = extras.attachments?.length
      ? extras.attachments
      : undefined;
    const callerLayers = await this.callerToolPolicies(
      identity,
      projectId,
      session.agent_id,
    );
    const turnOptions: TurnOptions = {
      ...agent.defaults,
      ...(session.model_effort
        ? { effort: session.model_effort as AgentEffort }
        : {}),
      ...(attachments ? { attachments } : {}),
      toolPolicies: callerLayers ?? {},
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
        if (!extras.persistedUserMessageId) {
          await trx
            .insertInto("agent_messages")
            .values({
              session_id: sessionId,
              role: "user",
              content: message,
              author_kind: "user",
              author_payload: {
                kind: "user",
                externalUserId: identity.externalUserId,
              },
              delivery_mode: "next_turn",
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
        }
        const assistant = await trx
          .insertInto("agent_messages")
          .values({
            session_id: sessionId,
            role: "assistant",
            content: "Thinking...",
            author_kind: "agent",
            author_payload: {
              kind: "agent",
              sessionId,
              agentId: session.agent_id,
            },
            delivery_mode: "message_only",
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
        events: stepLogEvents(segmentEvents),
      };
      const settledContent = heldText;
      // One transaction: a client poll must never observe the settled
      // preamble without its follow-up placeholder — that half-state
      // reads as "turn over" for a tick (activity line and working
      // indicators flicker off and back mid-turn).
      const next = await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("agent_messages")
          .set({ content: settledContent, metadata })
          .where("id", "=", assistantMessageId)
          .execute();
        return trx
          .insertInto("agent_messages")
          .values({
            session_id: sessionId,
            role: "assistant",
            content: "Thinking...",
            author_kind: "agent",
            author_payload: {
              kind: "agent",
              sessionId,
              agentId: session.agent_id,
            },
            delivery_mode: "message_only",
            metadata: progressMetadata([]),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
      });
      lastFlushed = { id: assistantMessageId, events: segmentEvents };
      heldText = undefined;
      segmentEvents = [];
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
      // The caller's view of the store, in the folder the agent works in
      // (ADR 0055): pulled before the turn, shipped after it.
      const storeDir = await this.storeSyncDir(identity, projectId, anchor);
      if (storeDir) {
        await syncRemoteProject(
          storeDir,
          documentsClientFor(this.storeSync!.documents, identity, projectId, {
            source: "store",
          }),
        ).catch((error) => {
          console.warn(
            `[catamorphic] store pull before turn failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }

      if (anchor.sandboxProviderId) {
        const workingDirectory = this.projectDir();
        const batchSkillStaged = await ensureBatchWorkflowSkill({
          sandboxProvider: this.sandboxProvider,
          sandboxProviderId: anchor.sandboxProviderId,
          projectDir: workingDirectory,
          seedFiles: this.seedFiles,
        });
        const durableSkillStaged = await ensureDurableWorkflowSkill({
          sandboxProvider: this.sandboxProvider,
          sandboxProviderId: anchor.sandboxProviderId,
          projectDir: workingDirectory,
          seedFiles: this.seedFiles,
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
          // A freshly re-anchored session (host restart, credential rebuild
          // after a re-auth) gets a re-send too: it was seeded from the
          // settled transcript, which excludes the failed turn's user
          // message — the harness has nothing to natively re-run, and
          // asking it to produced dead "Nothing to retry" failures.
          extras.retryOfAssistantId &&
            agent.provider.retryTurn &&
            !anchor.reanchored
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
        // Usage is accounting that arrives right before done (ADR 0057) —
        // never a progress beat, so it must not overwrite the activity line.
        if (event.type !== "done" && event.type !== "usage") {
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

      const settledWorkingDirectory =
        agent.topology === "native" && this.nativeAgentCheckout
          ? ((await this.nativeAgentCheckout.resolve({
              projectId,
              sessionId,
            })) ?? anchor.providerSession.workingDirectory)
          : anchor.providerSession.workingDirectory;
      anchor.providerSession.workingDirectory = settledWorkingDirectory;

      const changedFiles = anchor.sandboxProviderId
        ? await this.syncBackChanges(
            identity,
            projectId,
            anchor.sandboxProviderId,
          )
        : hostChangedFiles(events, settledWorkingDirectory);

      // Ship the turn's `store/` writes as the caller (ADR 0055) before the
      // checkpoint: store paths are gitignored, so they never enter git.
      let storeSync: JsonObject | undefined;
      if (storeDir) {
        try {
          const report = await shipRemoteProject(
            storeDir,
            documentsClientFor(this.storeSync!.documents, identity, projectId, {
              source: "store",
            }),
          );
          if (
            report.shipped.length +
              report.deleted.length +
              report.conflicts.length +
              report.notShippable.length +
              report.failed.length >
            0
          ) {
            storeSync = JSON.parse(JSON.stringify(report)) as JsonObject;
          }
        } catch (error) {
          storeSync = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // Checkpoint commit (ADR 0044): both harness families converge here —
      // sandbox edits just synced back, host edits are already in the tree.
      // Sweeps ALL dirty state (host harnesses under-report changed files);
      // failures log and never break the turn.
      const commitSha =
        agent.topology === "native" || changedFiles.length > 0
          ? await this.checkpointTurn(identity, projectId, message, {
              sessionId,
              workingDirectory: settledWorkingDirectory,
              nativeExecution: agent.topology === "native",
            })
          : null;

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

      const interrupted = this.interruptedTurns.delete(sessionId);
      const providerError = events
        .filter((event) => event.type === "error")
        .map((event) => event.content)
        .filter((content): content is string => Boolean(content))
        .join("\n");
      const content = settleFlushed
        ? undefined
        : failed && !interrupted
          ? providerError || "Agent failed"
          : (heldText ??
            (providerError || (questionEvent ? "" : "(no response)")));
      const errorKind = interrupted
        ? undefined
        : [...events]
            .reverse()
            .find((event) => event.type === "error" && event.errorKind)
            ?.errorKind;
      // The turn's accounting snapshot (ADR 0057): at most one usage event,
      // emitted by the harness just before done. It lands as metadata.usage
      // on the settled reply, where the composer's context meter reads it.
      const usageEvent = [...events]
        .reverse()
        .find((event) => event.type === "usage" && event.usage);
      const metadata: JsonObject = {
        status: failed
          ? "failed"
          : questionEvent
            ? "awaiting_input"
            : "completed",
        events: stepLogEvents(segmentEvents),
        changedFiles: changedFiles.map((change) => ({ ...change })),
        ...(usageEvent?.usage
          ? {
              usage: JSON.parse(JSON.stringify(usageEvent.usage)) as JsonObject,
            }
          : {}),
        // What the turn's store/ writes became (ADR 0055): shipped, refused,
        // conflicted, or outside store/. Hosts render it beside the reply.
        ...(storeSync ? { storeSync } : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(interrupted && failed ? { interrupted: true } : {}),
        ...(failed && !interrupted && heldText
          ? { partialContent: heldText }
          : {}),
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
        .set({
          ...(content === undefined ? {} : { content }),
          ...(commitSha ? { commit_sha: commitSha } : {}),
          metadata,
        })
        .where("id", "=", assistantMessageId)
        .returningAll()
        .executeTakeFirstOrThrow();

      const requestedNotification = workflowNotification(
        extras.requestMetadata,
      );
      const shouldRequestAttention =
        requestedNotification !== undefined &&
        (metadata.status === "completed" ||
          metadata.status === "awaiting_input" ||
          (metadata.status === "failed" &&
            errorKind !== "rate_limit" &&
            errorKind !== "unavailable" &&
            !interrupted));
      if (shouldRequestAttention) {
        await this.db
          .updateTable("agent_sessions")
          .set(({ ref }) => ({
            attention_revision: sql`${ref("attention_revision")} + 1`,
            updated_at: new Date(),
          }))
          .where("id", "=", sessionId)
          .execute();
      }

      if (this.onTurnSettled) {
        const settled: AgentTurnSettledEvent = {
          identity,
          projectId,
          sessionId,
          messageId: assistantMessageId,
          status: metadata.status as AgentTurnSettledEvent["status"],
          ...(shouldRequestAttention
            ? { notification: requestedNotification }
            : {}),
          changedFiles: changedFiles.map((change) => change.path),
          workingDirectory: settledWorkingDirectory,
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
              ? {
                  title: truncate(
                    messageWithAttachmentNames(message, attachments),
                    500,
                  ),
                }
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
        session.agent_id ?? this.codingAgents.defaultAgentId(projectId) ?? "",
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

    if (!session.allocation_id) {
      throw new Error("Agent session has no Environment Allocation");
    }
    const allocationId = session.allocation_id;

    const row = await this.db.transaction().execute(async (transaction) => {
      const closed = await transaction
        .updateTable("agent_sessions")
        .set({ status: "closed", updated_at: new Date() })
        .where("id", "=", sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.executionAllocations.release({
        identity,
        allocationId,
        transaction,
      });
      return closed;
    });

    await this.connectionGrants?.revokeAllocation({
      allocationId,
    });

    return mapSession(row, false, this.hostId, this.authorityLeaseMs);
  }

  // --- Agent resolution & anchoring ---

  private resolveAgent(
    agentId: string | null,
    projectId?: string,
  ): RegisteredCodingAgent {
    const id = agentId ?? this.codingAgents.defaultAgentId(projectId);
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
    /**
     * The provider session was created just now from the persisted
     * transcript (host restart, credential/config rebuild) instead of
     * resuming a live in-memory session. A fresh anchor does NOT hold
     * the in-flight turn — its user message is excluded from resurrection
     * history — so a retry cannot use the harness's native re-run.
     */
    reanchored: boolean;
  }> {
    if (agent.topology === "contained" || agent.topology === "external") {
      throw new UnsupportedAgentTopologyError(agent.topology);
    }
    const anchored =
      session.provider_session_id !== null &&
      session.provider === agent.provider.name &&
      // In-memory harness sessions die with a host restart or a provider
      // rebuild (credential/config edits drop the cached instance). When
      // the harness can tell us the session is gone, re-anchor with the
      // persisted transcript instead of running into a dead session.
      (agent.provider.hasSession?.(session.provider_session_id) ?? true);

    if (agent.topology === "native") {
      const workingDirectory = await this.resolveNativePath(
        projectId,
        session.id,
      );
      if (anchored && session.provider_session_id) {
        return {
          providerSession: {
            providerSessionId: session.provider_session_id,
            sessionId: session.id,
            projectId,
            sandboxId: "",
            workingDirectory,
          },
          reanchored: false,
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
          standingPrompt: this.standingAgentPrompt,
        }),
        attachedPlugins: await this.loadAttachedPlugins(projectId),
        history: await this.transcriptHistory(session.id),
        mcpServers: await this.connectionMcpServers(identity, session),
        ...(await this.callerOpts(identity, projectId, session.agent_id)),
      });
      await this.db
        .updateTable("agent_sessions")
        .set({
          provider: agent.provider.name,
          provider_session_id: providerSession.providerSessionId,
        })
        .where("id", "=", session.id)
        .execute();
      return { providerSession, reanchored: true };
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
        reanchored: false,
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
        standingPrompt: this.standingAgentPrompt,
      }),
      attachedPlugins: await this.loadAttachedPlugins(projectId),
      history: await this.transcriptHistory(session.id),
      mcpServers: await this.connectionMcpServers(identity, session),
      ...(await this.callerOpts(identity, projectId, session.agent_id)),
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
    return {
      providerSession,
      sandboxProviderId: handle.providerId,
      reanchored: true,
    };
  }

  private async connectionMcpServers(
    identity: Identity,
    session: SessionRow,
  ): Promise<Record<string, AgentMcpServerConfig>> {
    if (!session.allocation_id) {
      throw new Error("Agent session has no Environment Allocation");
    }
    if (!this.connectionGrants) return {};
    const allocation = await this.executionAllocations.get({
      identity,
      allocationId: session.allocation_id,
    });
    const bindings = allocation?.policy.connections ?? [];
    if (bindings.length === 0) return {};
    if (!this.connectionMcpUrl) {
      throw new Error(
        "connectionMcpUrl is required for an agent with brokered connections",
      );
    }
    const servers: Record<string, AgentMcpServerConfig> = {};
    for (const binding of bindings) {
      const url = this.connectionMcpUrl({
        projectId: session.project_id,
        sessionId: session.id,
        alias: binding.alias,
      });
      if (!url) {
        throw new Error("The connection MCP gateway is not reachable");
      }
      const grant = await this.connectionGrants.issue({
        identity,
        allocationId: session.allocation_id,
        agentSessionId: session.id,
        alias: binding.alias,
        ttlSeconds: 3600,
      });
      const serverName = connectionMcpServerName(binding.alias);
      servers[serverName] = {
        transport: "http",
        url,
        headers: { Authorization: `Bearer ${grant.token}` },
      };
    }
    return servers;
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

  private async resolveNativePath(
    projectId: string,
    sessionId: string,
  ): Promise<string> {
    const path = await this.nativeAgentCheckout?.resolve({
      projectId,
      sessionId,
    });
    if (!path) {
      throw new Error(
        "This agent uses native execution, but the Environment has no WorkerNode directory",
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
      seedFiles: this.seedFiles,
    });
    await ensureDurableWorkflowSkill({
      sandboxProvider: this.sandboxProvider,
      sandboxProviderId: prepared.providerId,
      projectDir: this.projectDir(),
      seedFiles: this.seedFiles,
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
      `git add -- ${paths}`,
      `git -c user.name=catamorphic -c user.email=agent@catamorphic.dev commit -m catamorphic-workflow-skills --quiet -- ${paths}`,
    ].join(" && ");
    // cwd via ExecOpts: see syncSandboxChanges — a `cd /workspace/...`
    // embedded in the command breaks providers without a mounted root.
    const result = await this.sandboxProvider.executeCommand(
      sandboxProviderId,
      command,
      { cwd: this.projectDir() },
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
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -b main >/dev/null)",
      "git add -A",
      `(git -c user.name=catamorphic -c user.email=agent@catamorphic.dev commit -m baseline --quiet || true)`,
    ].join(" && ");
    const result = await this.sandboxProvider.executeCommand(
      sandboxProviderId,
      command,
      { cwd: dir },
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

  /**
   * Commit the dev tree as this turn's checkpoint (ADR 0044). Returns the
   * commit sha (stamped on the assistant message), null when the tree was
   * clean or the commit failed — a checkpoint must never break a turn.
   */
  /**
   * The folder whose `store/` mirrors the caller's store view: the caller's
   * own dev copy, which sandbox agents' edits sync back into. Host-execution
   * agents work in ONE folder per project shared by every caller, so their
   * store/ is never synced (one member's pulled files would be readable by
   * the next member's agent, and ships would carry the wrong author) —
   * they reach the store through the `documents_*` tools instead. Null when
   * the host did not enable store sync.
   */
  private async storeSyncDir(
    identity: Identity,
    projectId: string,
    anchor: { providerSession: ProviderSession; sandboxProviderId?: string },
  ): Promise<string | null> {
    if (!this.storeSync) return null;
    if (!anchor.sandboxProviderId) return null;
    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return repo.repoPath;
    } finally {
      await repo.dispose();
    }
  }

  private async checkpointTurn(
    identity: Identity,
    projectId: string,
    userMessage: string,
    execution: {
      sessionId: string;
      workingDirectory: string;
      nativeExecution: boolean;
    },
  ): Promise<string | null> {
    try {
      if (execution.nativeExecution && this.nativeAgentCheckout?.checkpoint) {
        return await this.nativeAgentCheckout.checkpoint({
          projectId,
          sessionId: execution.sessionId,
          workingDirectory: execution.workingDirectory,
          message: checkpointMessage(userMessage),
        });
      }
      const repo = await this.projectManager.openDev(
        identity.tenantId,
        projectId,
        identity.externalUserId,
      );
      try {
        const status = await repo.status();
        if (!status.dirty) return null;
        return await repo.commit(
          checkpointMessage(userMessage),
          CHECKPOINT_AUTHOR,
        );
      } finally {
        await repo.dispose();
      }
    } catch (error) {
      console.warn(
        `[catamorphic] turn checkpoint commit failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
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

  /**
   * The session surface admits builders and — ADR 0055 — scoped callers
   * whose scope names at least one of this project's agents. Everything
   * such a caller does is then checked against those agent refs.
   */
  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    if (
      !isBuilder(identity, projectId) &&
      this.coveredAgentIds(identity, projectId).length === 0
    ) {
      throw new AccessDeniedError();
    }
    await requireTenantProject(this.db, identity.tenantId, projectId);
  }

  /** Registry ids of the project agents a scoped identity's refs name. */
  private coveredAgentIds(identity: Identity, projectId: string): string[] {
    return (identity.scope ?? [])
      .filter(
        (ref): ref is AgentRef =>
          ref.kind === "agent" && ref.projectId === projectId,
      )
      .map((ref) => `project:${projectId}:${ref.name}`);
  }

  /** Every scope entry that covers this agent id, for a scoped caller. */
  private coveringAgentRefs(
    identity: Identity,
    projectId: string,
    agentId: string | null,
  ): AgentRef[] {
    if (!agentId || !identity.scope) return [];
    const parsed = parseProjectAgentId(agentId);
    if (!parsed || parsed.projectId !== projectId) return [];
    const ref: AgentRef = { kind: "agent", projectId, name: parsed.slug };
    if (!scopeCovers(identity.scope, ref)) return [];
    return identity.scope.filter(
      (entry): entry is AgentRef =>
        entry.kind === "agent" &&
        entry.projectId === projectId &&
        entry.name === parsed.slug,
    );
  }

  private coveringAgentRef(
    identity: Identity,
    projectId: string,
    agentId: string | null,
  ): AgentRef | undefined {
    return this.coveringAgentRefs(identity, projectId, agentId)[0];
  }

  /**
   * A builder may use any agent; a scoped caller only a project agent its
   * scope names — never the host's default or personal agents (a
   * `null` agent id), which are not project artifacts.
   */
  private assertAgentAccess(
    identity: Identity,
    projectId: string,
    agentId: string | null,
  ): void {
    if (isBuilder(identity, projectId)) return;
    if (!this.coveringAgentRef(identity, projectId, agentId)) {
      throw new AccessDeniedError();
    }
  }

  /**
   * The caller's tool-policy layers for a session (ADR 0055), or undefined
   * for builders. Two sources, both narrowing only:
   *  - the project's tools server (`catamorphic`): everything off except
   *    the tools whose workflows the caller's scope resolves to (plus the
   *    shared poll tool — run reads are scope-checked at the endpoint);
   *  - the agent ref's own `toolPolicies`, per connector server key.
   * The endpoint enforces scope independently when the host binds the
   * caller to the session's MCP credentials; this layer is defence in
   * depth and the ask/deny vocabulary the endpoint cannot express.
   */
  private async callerToolPolicies(
    identity: Identity,
    projectId: string,
    agentId: string | null,
  ): Promise<Record<string, McpToolPolicyLayers> | undefined> {
    if (isBuilder(identity, projectId)) return undefined;
    const refs = this.coveringAgentRefs(identity, projectId, agentId);
    if (refs.length === 0) throw new AccessDeniedError();
    const layers: Record<string, McpToolPolicyLayers> = {};

    // The project tools server serves the workflow tools AND the documents /
    // skills / publications / proposals / ask_agent surface, each of which
    // authorizes itself against the caller's scope. This layer therefore
    // denies only the WORKFLOW tools the scope does not resolve to and lets
    // everything else through to the endpoint's own checks.
    const resolved = await resolveScope({
      db: this.db,
      identity,
      projectId,
      policies: this.appPolicies,
    });
    if (resolved && this.mcpToolNames) {
      // The roster is read as the shared program reader: a viewer must not
      // get a working copy of the project just to learn the tool names.
      const roster = await this.mcpToolNames(
        { tenantId: identity.tenantId, externalUserId: PROGRAM_READER },
        projectId,
      );
      const tools: Record<string, ToolPermission> = {};
      for (const [tool, workflow] of roster) {
        if (!resolved.allowedWorkflows.has(workflow)) tools[tool] = "deny";
      }
      layers[PROJECT_TOOLS_SERVER_KEY] = [{ default: "allow", tools }];
    }

    // Every covering ref contributes its narrowing (two roles naming the
    // same agent intersect: the strictest answer wins, order-independent).
    for (const ref of refs) {
      for (const [name, policy] of Object.entries(ref.toolPolicies ?? {})) {
        const key =
          name === PROJECT_TOOLS_SERVER_KEY ? name : serverKeyOf(name);
        layers[key] = [
          ...(layers[key] ?? []),
          narrowingLayer({
            ...(policy.default ? { default: policy.default } : {}),
            ...(policy.tools ? { tools: { ...policy.tools } } : {}),
          }),
        ];
      }
    }
    return layers;
  }

  /** `caller` + `toolPolicies` for {@link StartSessionOpts}. */
  private async callerOpts(
    identity: Identity,
    projectId: string,
    agentId: string | null,
  ): Promise<{
    caller: Identity;
    toolPolicies?: Record<string, McpToolPolicyLayers>;
  }> {
    const toolPolicies = await this.callerToolPolicies(
      identity,
      projectId,
      agentId,
    );
    // Builders send an EMPTY map, not none: a turn's layers replace the
    // session's, so a builder continuing a viewer's session sheds the
    // viewer's narrowing instead of inheriting it.
    return { caller: identity, toolPolicies: toolPolicies ?? {} };
  }

  /** Ownership check without loading messages: throws when the session
   * isn't the caller's / the project's. */
  async assertSession(
    identity: Identity,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    await this.requireSession(identity, projectId, sessionId);
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
    assertAgentSessionAccess({
      identity,
      projectId,
      externalUserId: row.external_user_id,
      agentId: row.agent_id,
    });
    return row;
  }
}

function progressMetadata(events: AgentEvent[]): JsonObject {
  return {
    status: "in_progress",
    events: stepLogEvents(events),
  };
}

/**
 * Events serialized into a message's step log. Usage events are accounting
 * (ADR 0057) — stamped on the settled message as `metadata.usage`, never
 * rendered as activity rows — so they are filtered out here.
 */
function stepLogEvents(events: AgentEvent[]): JsonObject[] {
  return JSON.parse(
    JSON.stringify(events.filter((event) => event.type !== "usage")),
  ) as JsonObject[];
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
  // Never the text itself: a preamble held on the in-progress row would
  // show on the live activity line and then land again as the flushed
  // message — the same words twice. The prose belongs to the message; the
  // live line stays a calm verb.
  if (event.type === "text") return "Writing...";
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

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

function mapSession(
  row: SessionRow,
  running = false,
  hostId?: string,
  authorityLeaseMs = 90_000,
): AgentSession {
  const leaseExpiresAt = new Date(
    row.authority_seen_at.getTime() + authorityLeaseMs,
  );
  const resumable =
    hostId !== undefined &&
    row.status === "active" &&
    row.handoff_status === "none" &&
    row.authority_host_id !== "unassigned" &&
    row.authority_host_id !== hostId &&
    row.mirror_message_count > 0 &&
    leaseExpiresAt.getTime() <= Date.now();
  return {
    id: row.id,
    projectId: row.project_id,
    externalUserId: row.external_user_id,
    provider: row.provider,
    source: parseSessionSource(row.source),
    providerSessionId: row.provider_session_id,
    sandboxId: row.sandbox_id,
    environment: row.environment_name,
    allocationId: row.allocation_id,
    agentId: row.agent_id,
    modelEffort: (row.model_effort as AgentEffort | null) ?? null,
    title: row.title,
    icon: row.icon,
    parentSessionId: row.parent_session_id,
    activity: row.activity,
    todos: agentTodos(row.todos),
    authorityHostId: row.authority_host_id,
    authorityRevision: Number(row.authority_revision),
    authoritySeenAt: row.authority_seen_at.toISOString(),
    mirrorMessageCount: row.mirror_message_count,
    handoffStatus: parseHandoffStatus(row.handoff_status),
    handoffDestinationHostId: row.handoff_destination_host_id,
    resumable,
    pausedAt: resumable ? leaseExpiresAt.toISOString() : null,
    running,
    attentionRevision: Number(row.attention_revision),
    attentionSeenRevision: Number(row.attention_seen_revision),
    attentionRequired:
      Number(row.attention_revision) > Number(row.attention_seen_revision),
    status: row.status as "active" | "closed",
    baseCommitSha: row.base_commit_sha,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function workflowNotification(
  metadata: JsonObject | null | undefined,
): { title?: string; body?: string } | undefined {
  const value = metadata?.workflowNotification;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : undefined;
  const body =
    typeof value.body === "string" && value.body.trim()
      ? value.body.trim()
      : undefined;
  return {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
}

function parseSessionSource(value: string): AgentSessionSource {
  switch (value) {
    case "desktop":
    case "mobile":
    case "slack":
    case "claude":
    case "mcp":
    case "api":
      return value;
    default:
      return "api";
  }
}

function parseHandoffStatus(value: string): AgentSession["handoffStatus"] {
  if (value === "none" || value === "pending") return value;
  throw new Error(`Invalid agent session handoff status '${value}'`);
}

function agentTodos(value: unknown): AgentTodo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const item = entry;
    if (
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.description !== "string" ||
      (item.status !== "pending" &&
        item.status !== "in_progress" &&
        item.status !== "completed")
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        title: item.title,
        description: item.description,
        status: item.status,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentTodosJson(value: readonly AgentTodoInput[]) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

function mapMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    commitSha: row.commit_sha,
    metadata: row.metadata as Record<string, unknown> | null,
    author: parseMessageAuthor(row),
    deliveryMode: parseMessageDeliveryMode(row.delivery_mode),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  };
}

export function modelVisibleDelivery(
  content: string,
  author: SessionMessageAuthor,
): string {
  switch (author.kind) {
    case "user":
      return content;
    case "agent":
      return `[Catamorphic agent message from session ${author.sessionId}${author.agentId ? ` using ${author.agentId}` : ""}. This message was not written by the user.]\n\n${content}`;
    case "workflow":
      return `[Catamorphic workflow message from ${author.workflowName}, run ${author.runId}. This message was not written by the user.]\n\n${content}`;
    case "watcher":
      return `[Catamorphic watcher message from ${author.watcherId}${author.runId ? `, run ${author.runId}` : ""}. This message was not written by the user.]\n\n${content}`;
    case "system":
      return `[Catamorphic system message: ${author.code}. This message was not written by the user.]\n\n${content}`;
  }
}

function parseMessageDeliveryMode(value: string): SessionDeliveryMode {
  if (
    value !== "message_only" &&
    value !== "next_turn" &&
    value !== "interrupt"
  ) {
    throw new Error(`Invalid agent message delivery mode '${value}'`);
  }
  return value;
}

function parseMessageAuthor(row: MessageRow): SessionMessageAuthor {
  const payload = row.author_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Agent message '${row.id}' has an invalid author payload`);
  }
  if (
    row.author_kind === "user" &&
    typeof payload.externalUserId === "string"
  ) {
    return { kind: "user", externalUserId: payload.externalUserId };
  }
  if (
    row.author_kind === "agent" &&
    typeof payload.sessionId === "string" &&
    (typeof payload.agentId === "string" || payload.agentId === null)
  ) {
    return {
      kind: "agent",
      sessionId: payload.sessionId,
      agentId: payload.agentId,
    };
  }
  if (
    row.author_kind === "workflow" &&
    typeof payload.runId === "string" &&
    typeof payload.workflowName === "string"
  ) {
    return {
      kind: "workflow",
      runId: payload.runId,
      workflowName: payload.workflowName,
    };
  }
  if (
    row.author_kind === "watcher" &&
    typeof payload.watcherId === "string" &&
    (payload.runId === undefined || typeof payload.runId === "string")
  ) {
    return {
      kind: "watcher",
      watcherId: payload.watcherId,
      ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
    };
  }
  if (row.author_kind === "system" && typeof payload.code === "string") {
    return { kind: "system", code: payload.code };
  }
  throw new Error(`Agent message '${row.id}' has an invalid author payload`);
}
