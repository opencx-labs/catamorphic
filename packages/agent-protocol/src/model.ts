/**
 * The agent session model (ADR 0197): a session holds turns, a turn holds
 * attempts, and items are the ordered transcript. Work owns every id here;
 * a provider's own ids are {@link NativeRef}s beside them.
 *
 * Everything in this module is JSON on the wire and in the session event
 * log, shared by the server's projections and every client's reducer.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * How much a provider id can be trusted to identify the same thing again:
 * `strong` ids are stable and unique (Codex thread and turn ids), `weak`
 * ones need a scope (an ordinal within a turn), `none` means Work
 * allocated the id itself.
 */
export type RefStrength = "strong" | "weak" | "none";

export interface NativeRef {
  id: string;
  strength: RefStrength;
}

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** All effort levels, low → max (UI orderings, validation). */
export const AGENT_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AgentEffort[];

/**
 * Classified failure category. `auth` offers a re-connect path,
 * `rate_limit`/`unavailable` explain a provider outage (retrying needs a
 * separate safety signal), `model_incompat` retries with sanitized
 * reasoning history. Unclassified errors offer a manual retry.
 */
export type AgentErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "model_incompat";

/**
 * Per-turn token and cost accounting (ADR 0057). Every field is optional:
 * each harness fills what its stream reports. Counters cover the whole
 * turn; `contextTokens`/`contextWindow` describe the context after it.
 */
export interface AgentTurnUsage {
  model?: string;
  /** Uncached input tokens (never includes the cached portion). */
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  /** Subset of outputTokens; informational, never added to totals. */
  reasoningTokens?: number;
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface AgentQuestionOption {
  /** Concise display label (1-5 words). */
  label: string;
  /** Explanation of what this option means or implies. */
  description: string;
}

export interface AgentQuestion {
  /** The complete question, e.g. "Which library should we use?" */
  question: string;
  /** Very short chip label (max ~12 characters), e.g. "Auth method". */
  header: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/** Where a text attachment came from: shown on the pill, told to the model. */
export type AgentTextSource =
  | { type: "paste" }
  | {
      type: "selection";
      /** Project-relative path of the file the text was selected in. */
      filePath: string;
      /** 1-based inclusive line range, when known. */
      startLine?: number;
      endLine?: number;
    }
  | { type: "url"; url: string }
  | { type: "path"; path: string }
  | {
      /**
       * An open workspace tab (browser page, editor, terminal, chat…)
       * dragged into the composer. The key addresses it through the
       * workspace tools (`read_tab`); title/url/filePath are what the pill
       * shows and what the model reads without a tool call.
       */
      type: "tab";
      key: string;
      kind: string;
      title: string;
      url?: string;
      filePath?: string;
    };

/** A media file sent along with a user message. */
export interface AgentMediaAttachment {
  kind: "image" | "document";
  name: string;
  /** MIME type, e.g. "image/png", "application/pdf". */
  mediaType: string;
  dataBase64: string;
}

/**
 * Text context sent along with a user message: a big paste, an editor
 * selection, a URL, a file path. Delivered as structured context beside the
 * prose, never spliced into the person's own words.
 */
export interface AgentTextAttachment {
  kind: "text";
  /** Short label (first line of a paste, `file.md · 12–24`, the URL…). */
  name: string;
  text: string;
  source: AgentTextSource;
}

export type AgentAttachment = AgentMediaAttachment | AgentTextAttachment;

/** The person who wrote a {@link UserMessageItem}. */
export interface SessionUser {
  kind: "user";
  externalUserId: string;
}

/**
 * Who sent a session words that are not the person's (ADR 0217): another
 * agent's chat, a person's own assistant outside Work (an MCP client of
 * the project), or a workflow.
 */
export type InboundSender =
  | {
      kind: "agent";
      sessionId: string;
      agentId: string | null;
      /** The chat's project, when it is not the receiving session's. */
      projectId?: string;
    }
  | { kind: "assistant"; externalUserId: string }
  | {
      kind: "workflow";
      runId: string;
      workflowName: string;
      /** The workflow's `@displayname`, for people; `workflowName` is code. */
      displayName?: string;
      /** The enablement that ran it, when one did (ADR 0156). */
      enablementId?: string;
      /** The temporary watcher it ran as, and the chat it watches for (ADR 0074). */
      watcher?: { id: string; sessionId: string };
      /** A scheduled run: when it was due. */
      scheduledFor?: string;
      /** When its trigger fired. */
      firedAt?: string;
    };

/** Who wrote an input: the person, or an {@link InboundSender}. */
export type SessionMessageAuthor = SessionUser | InboundSender;

/** How a task an agent started stands, as a {@link TaskNotificationItem} reports it. */
export type TaskNotificationStatus =
  /** It finished as hoped. */
  | "completed"
  /** It failed, or ended in an error. */
  | "failed"
  /** Still going: it printed, changed or said what the agent asked to hear. */
  | "update"
  /** It waits on the person: a question, an approval. */
  | "needs_input"
  /** It ended before finishing: interrupted, archived, closed, expired. */
  | "stopped";

/**
 * Where a person opens what an input came from: a chat, a workflow run, or
 * a surface of the host's workspace (a background command's terminal).
 */
export type InputSource =
  | {
      kind: "session";
      sessionId: string;
      /** The chat's project, when it is not the receiving session's. */
      projectId?: string;
    }
  | { kind: "workflow_run"; runId: string; workflowName: string }
  | { kind: "surface"; key: string };

/** A task an agent started that Work runs and reports on. */
export interface NotifiedTask {
  /**
   * What kind of task: `background_command`, `command_watch`, `subsession`,
   * `followed_session`, or a host's own.
   */
  type: string;
  id: string;
  /** The task's own name: a command's description, a subagent's title. */
  title: string;
  /** How it stands as of this notification. */
  status: TaskNotificationStatus;
}

/** A person's answer to an agent's questions (ADR 0195). */
export interface QuestionAnswer {
  /** The question request it answers. */
  requestId: string;
  questions: AgentQuestion[];
  /** One per question, as the person picked or wrote it. */
  answers: string[];
}

/** What people are told when the turn an input started settles. */
export interface SettledAlert {
  title?: string;
  body?: string;
}

/**
 * What a delivery puts into a session (ADR 0217): a person's words, words
 * someone else sent, or Work's notification about a task the agent
 * started. Each becomes the item of the same kind.
 */
export type SessionInput =
  | {
      kind: "user_message";
      author: SessionUser;
      text: string;
      attachments: AgentAttachment[];
      /** Present when the words answer the agent's questions. */
      answer?: QuestionAnswer;
    }
  | {
      kind: "inbound_message";
      from: InboundSender;
      text: string;
      attachments: AgentAttachment[];
      /** A workflow's ask that its chat's people hear when the turn settles. */
      alert?: SettledAlert;
    }
  | {
      kind: "task_notification";
      task: NotifiedTask;
      /** One line for people, and the head of what the agent reads. */
      summary: string;
      /** What the agent reads after the summary: output, a result, a change. */
      detail: string;
      source: InputSource | null;
    };

/** The input a sender's words become: the person's, or someone else's. */
export function messageInput(input: {
  author: SessionMessageAuthor;
  text: string;
  attachments?: AgentAttachment[];
}): Extract<SessionInput, { kind: "user_message" | "inbound_message" }> {
  const attachments = input.attachments ?? [];
  return input.author.kind === "user"
    ? {
        kind: "user_message",
        author: input.author,
        text: input.text,
        attachments,
      }
    : {
        kind: "inbound_message",
        from: input.author,
        text: input.text,
        attachments,
      };
}

/**
 * How a delivered input runs (ADR 0197): `queue` becomes the next turn,
 * `steer` joins the active turn (natively, or by restarting its attempt),
 * `interrupt` stops the active turn and runs next, `message_only` is an
 * attributed delivery that starts nothing.
 */
export type DispatchMode = "queue" | "steer" | "interrupt" | "message_only";

export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export interface AgentTodo {
  id: string;
  title: string;
  description: string;
  status: AgentTodoStatus;
  /** What the agent does while this is in progress ("Reviewing migrations"). */
  activeForm?: string;
}

// ---------------------------------------------------------------------------
// Turns and attempts

export type TurnStatus =
  /** Waiting in the session's queue. */
  | "queued"
  /** Queued, but held back until someone releases it. */
  | "held"
  /** Claimed: the workspace, grants and provider thread are being readied. */
  | "preparing"
  /** The harness is working. */
  | "running"
  /** The harness waits on a runtime request (a question, an approval). */
  | "waiting"
  /** The harness finished; changes are being synced and checkpointed. */
  | "finalizing"
  | "completed"
  | "failed"
  /** Stopped by a person, or by the machine running it going away. */
  | "interrupted"
  /** Withdrawn before it ran. */
  | "cancelled"
  /** Undone by a rollback to an earlier turn. */
  | "rolled_back";

export const SETTLED_TURN_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
] as const satisfies readonly TurnStatus[];

export const ACTIVE_TURN_STATUSES = [
  "preparing",
  "running",
  "waiting",
  "finalizing",
] as const satisfies readonly TurnStatus[];

export function isSettledTurnStatus(status: TurnStatus): boolean {
  return (SETTLED_TURN_STATUSES as readonly TurnStatus[]).includes(status);
}

export function isActiveTurnStatus(status: TurnStatus): boolean {
  return (ACTIVE_TURN_STATUSES as readonly TurnStatus[]).includes(status);
}

export interface TurnError {
  message: string;
  kind?: AgentErrorKind;
  /** True only when the provider confirmed it rejected the turn before any work. */
  retrySafe?: boolean;
}

/** One file a turn changed, as the workspace sync saw it. */
export interface TurnFileChange {
  path: string;
  kind: "modified" | "deleted";
}

/** What a settled turn left behind. */
export interface TurnOutcome {
  changedFiles: TurnFileChange[];
  usage?: AgentTurnUsage;
  /** What the turn's store writes became (ADR 0055). */
  storeSync?: JsonObject;
  /** The workspace's changes could not be read; they stayed in the sandbox. */
  workspaceSync?: { error: string };
  /** A workflow asked the host to surface this turn. */
  notification?: { title?: string; body?: string };
}

export interface Turn {
  id: string;
  sessionId: string;
  /** 1-based order of the session's turns. */
  ordinal: number;
  status: TurnStatus;
  /** The input that started the turn; null for a continuation Work queued. */
  inputItemId: string | null;
  /** `interrupt` turns jump the queue and stop the active turn. */
  dispatch: "queue" | "interrupt";
  priority: number;
  /** The agent's live line while it works. */
  activity: string | null;
  activityAt: string | null;
  attemptCount: number;
  activeAttemptId: string | null;
  providerThreadId: string | null;
  /** When a queued retry becomes due. */
  retryAt: string | null;
  cancellationRequested: boolean;
  error: TurnError | null;
  outcome: TurnOutcome | null;
  /** Workspace commits around the turn (ADR 0044); rollback restores `before`. */
  checkpoint: { before: string | null; after: string | null };
  /** The turn this one continues after its machine stopped (ADR 0198). */
  continuationOf: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type AttemptReason = "initial" | "retry" | "steer_restart" | "recovery";

export type AttemptStatus =
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  /** The runner went away mid-attempt (ADR 0198). */
  | "lost"
  /** Replaced by a later attempt of the same turn (steer restart). */
  | "superseded";

export interface Attempt {
  id: string;
  turnId: string;
  sessionId: string;
  /** 1-based within the turn. */
  ordinal: number;
  reason: AttemptReason;
  status: AttemptStatus;
  providerThreadId: string | null;
  nativeTurnRef: NativeRef | null;
  error: TurnError | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Items

export type ItemStatus = "in_progress" | "completed" | "failed" | "cancelled";

export interface ItemCommon {
  id: string;
  sessionId: string;
  /** Null for inputs that started nothing, and for items before turns existed. */
  turnId: string | null;
  attemptId: string | null;
  /** The native subagent item this one ran under, for nested display. */
  parentItemId: string | null;
  /** Transcript order: the sequence of the event that added the item. */
  position: number;
  status: ItemStatus;
  nativeRef: NativeRef | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** What every delivered input carries besides its own fields (ADR 0219). */
export interface DeliveryFields {
  dispatch: DispatchMode;
  /** A delivery that asked the owner to look (ADR 0090). */
  attention: "required" | null;
  idempotencyKey: string | null;
  /**
   * The member whose call delivered it, whoever wrote it: a turn on the
   * chat owner's own sign-in takes in only their own doing (ADR 0199).
   * Null for what was delivered before Work recorded it.
   */
  deliveredBy: string | null;
  /** The enablements whose runs led to it, oldest first (ADR 0090). */
  causation: string[];
}

/**
 * A person's message. Only people write these (ADR 0217): anything else
 * that reaches the agent is an {@link InboundMessageItem} or a
 * {@link TaskNotificationItem}.
 */
export interface UserMessageItem
  extends ItemCommon,
    DeliveryFields,
    Extract<SessionInput, { kind: "user_message" }> {}

/**
 * Words someone other than the person sent this session: another agent, a
 * person's own assistant, or a workflow. A `message_only` one is
 * `in_progress` until a turn takes it in.
 */
export interface InboundMessageItem
  extends ItemCommon,
    DeliveryFields,
    Extract<SessionInput, { kind: "inbound_message" }> {}

/**
 * Work's report on a task the agent started: a background command, a
 * watch, a subsession, a followed chat. A `message_only` one is
 * `in_progress` until a turn takes it in.
 */
export interface TaskNotificationItem
  extends ItemCommon,
    DeliveryFields,
    Extract<SessionInput, { kind: "task_notification" }> {}

/** An item a delivery added: what a turn takes in. */
export type InputItem =
  | UserMessageItem
  | InboundMessageItem
  | TaskNotificationItem;

export const INPUT_ITEM_KINDS = [
  "user_message",
  "inbound_message",
  "task_notification",
] as const satisfies readonly InputItem["kind"][];

export function isInputItem(item: Item): item is InputItem {
  return (INPUT_ITEM_KINDS as readonly string[]).includes(item.kind);
}

export interface AssistantMessageItem extends ItemCommon {
  kind: "assistant_message";
  text: string;
  agentId: string | null;
}

export interface ReasoningItem extends ItemCommon {
  kind: "reasoning";
  text: string;
}

export interface ToolCallItem extends ItemCommon {
  kind: "tool_call";
  /** The tool as the harness named it (`mcp__server__tool`, `WebSearch`). */
  tool: string;
  /** The MCP server, when the tool came from one. */
  server: string | null;
  /** A few human words for what the call does, when the agent wrote them. */
  description: string | null;
  input: JsonValue;
  result: JsonValue | null;
  error: string | null;
}

export interface CommandItem extends ItemCommon {
  kind: "command";
  command: string;
  description: string | null;
  output: string;
  exitCode: number | null;
}

export interface FileChangeItem extends ItemCommon {
  kind: "file_change";
  path: string;
  change: "created" | "modified" | "deleted" | "renamed" | null;
  previousPath: string | null;
}

export interface PlanItem extends ItemCommon {
  kind: "plan";
  steps: Array<{
    text: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

export interface RequestItem extends ItemCommon {
  kind: "request";
  requestId: string;
}

/**
 * Work that ran as a subagent. A Work subsession is a session of its own
 * (`childSessionId`); a harness's private subagent nests its items under
 * this one through `parentItemId`.
 */
export interface SubagentItem extends ItemCommon {
  kind: "subagent";
  title: string;
  agentType: string | null;
  childSessionId: string | null;
  result: string | null;
}

/** A line Work itself wrote into the transcript. */
export interface NoticeItem extends ItemCommon {
  kind: "notice";
  /** Machine-readable kind, e.g. `agent_changed`, `turn_lost`, `workspace_moved`. */
  code: string;
  text: string;
  data: JsonObject;
}

export type ContextHandoffStrategy =
  /** Returning to an earlier provider thread: only what it has not seen. */
  | "delta"
  /** A fresh provider thread seeded with the whole conversation. */
  | "full";

/**
 * What an agent was told about turns its provider thread did not see
 * (ADR 0198): after a switch of harness, a lost native state, or a fork.
 */
export interface ContextHandoffItem extends ItemCommon {
  kind: "context_handoff";
  strategy: ContextHandoffStrategy;
  fromProviderThreadIds: string[];
  toProviderThreadId: string;
  coveredTurnOrdinals: { from: number; to: number };
  text: string;
}

export type Item =
  | UserMessageItem
  | InboundMessageItem
  | TaskNotificationItem
  | AssistantMessageItem
  | ReasoningItem
  | ToolCallItem
  | CommandItem
  | FileChangeItem
  | PlanItem
  | RequestItem
  | SubagentItem
  | NoticeItem
  | ContextHandoffItem;

export type ItemKind = Item["kind"];

/** An item's own fields, without the identity and placement Work assigns. */
export type ItemPayload<K extends ItemKind = ItemKind> = K extends ItemKind
  ? Omit<Extract<Item, { kind: K }>, keyof ItemCommon>
  : never;

// ---------------------------------------------------------------------------
// Runtime requests

export type RuntimeRequestKind = "question" | "approval" | "elicitation";

export type RuntimeRequestStatus =
  | "pending"
  | "resolved"
  | "expired"
  | "cancelled";

export interface RuntimeRequestOrigin {
  kind: "tool" | "provider" | "mcp" | "host";
  id: string;
  displayName?: string;
}

export type RuntimeRequestResponse =
  | {
      kind: "approval";
      decision: "approved" | "denied";
      remember?: "always";
      /** Why Work denied it when no person did: told to the agent. */
      reason?: string;
    }
  | { kind: "question"; answers: string[] }
  | {
      kind: "elicitation";
      action: "accept" | "decline" | "cancel";
      content?: JsonValue;
    };

export interface RuntimeRequest {
  id: string;
  sessionId: string;
  turnId: string | null;
  attemptId: string | null;
  itemId: string | null;
  kind: RuntimeRequestKind;
  status: RuntimeRequestStatus;
  /**
   * Whether an answer still reaches the agent that asked. False once its
   * attempt is gone (ADR 0198): the request stays visible, unanswerable.
   */
  answerable: boolean;
  /** Whether the asking agent waits; a non-blocking question's answer arrives as a message. */
  blocking: boolean;
  title: string;
  description: string | null;
  origin: RuntimeRequestOrigin;
  questions: AgentQuestion[] | null;
  approval: {
    action: string;
    details?: string;
    tool?: { server: string | null; name: string; input: JsonValue };
  } | null;
  elicitation: {
    server: string;
    message: string;
    schema?: JsonObject;
    url?: string;
  } | null;
  /** People who may answer besides those who may change the chat (ADR 0176). */
  approvers: string[];
  expiresAt: string | null;
  response: RuntimeRequestResponse | null;
  resolvedBy: string | null;
  /** Why it was expired or cancelled, for people. */
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** The runner's own key for the request: how an answer finds its harness. */
  runnerKey?: string;
}

// ---------------------------------------------------------------------------
// Provider threads

/**
 * A harness's native conversation a session's turns ran on. A session may
 * have several over time (a switch of harness, a lost native state); turns
 * name the one they ran on.
 */
export interface ProviderThread {
  id: string;
  sessionId: string;
  /** The harness, e.g. `claude-code`, `codex`, `ai-sdk`. */
  harness: string;
  nativeRef: NativeRef | null;
  status: "active" | "unavailable" | "closed";
  /** The last turn this thread saw, for delta handoffs. */
  lastTurnOrdinal: number | null;
  /** Its native state is stored with Work and can resume on any machine. */
  portable: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Session

/**
 * A session's metadata (ADR 0225): values by key, each any JSON. Keys and
 * sizes are bounded ({@link SESSION_METADATA_LIMITS}).
 */
export type SessionMetadata = { [key: string]: JsonValue };

/** A session's shared fields: what every viewer sees alike. */
export interface SessionFields {
  id: string;
  projectId: string;
  title: string | null;
  icon: string | null;
  agentId: string | null;
  /**
   * The harness the conversation runs on: its first turn binds it and it
   * stays (ADR 0214). Null until then. Each copy binds its own (ADR 0197).
   */
  harness: string | null;
  model: string | null;
  modelEffort: AgentEffort | null;
  status: "active" | "closed";
  workStatus: "open" | "completed";
  activity: string | null;
  todos: AgentTodo[];
  /**
   * Named JSON values agents and people set on the session, read by
   * clients (ADR 0225): a sidebar section shows `pull_requests`, a
   * person's own section shows the keys their agent sets.
   */
  metadata: SessionMetadata;
  parentSessionId: string | null;
  forkedFromSessionId: string | null;
  attentionRevision: number;
  environment: string | null;
  authorityHostId: string;
  authorityRevision: number;
  handoffStatus: "none" | "pending";
  updatedAt: string;
}
