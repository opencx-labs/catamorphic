"use client";

import {
  type AgentAttachment,
  activeTurn as activeTurnOf,
  type CommandReceipt,
  type Item,
  pendingRequests,
  type RuntimeRequest,
  type RuntimeRequestResponse,
  type SessionState,
  type Turn,
} from "@catamorphic/agent-protocol";
import { ATTACHMENT_MARKER } from "@catamorphic/sandbox/attachments";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { CatamorphicError, toCatamorphicError } from "../lib/errors.js";
import { randomId } from "../lib/random-id.js";
import {
  type SessionCommandInput,
  sendSessionCommand,
} from "../lib/session-commands.js";
import {
  type QueuedMessage,
  sessionQueue,
  sessionTimeline,
  startingTurn,
  type TimelineTurn,
} from "../lib/session-timeline.js";
import { useCatamorphic } from "../provider.js";
import type { AgentSessionDetail } from "../types.js";
import {
  type AgentSessionConnection,
  type AgentSessionInfo,
  agentSessionQueryKey,
  useAgentSession,
} from "./use-agent-session.js";
import { useCreateAgentSession } from "./use-create-agent-session.js";

export type AgentChatAttachment = AgentAttachment;

export interface UseAgentChatOptions {
  /**
   * Open an existing session instead of lazily creating one on first send.
   * When it changes the hook resets, so hosts can drive session selection
   * from a sidebar. Lazily created sessions are reported through
   * {@link UseAgentChatOptions.onSessionCreated}.
   */
  sessionId?: string;
  /** Called when the hook lazily creates a session on first send. */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Host-registry key of the agent for lazily created sessions. Read at
   * send time, so hosts can change it up until the first message.
   */
  agentId?: string;
  /** Per-session overrides captured when the first message creates the session. */
  model?: string;
  effort?: AgentSessionDetail["modelEffort"];
  /** Logical Environment for a lazily created session. */
  environment?: string;
  /** Surface creating a lazy session. Informational provenance only. */
  source?: AgentSessionDetail["source"];
  /** Stream live events (default true). */
  live?: boolean;
}

/**
 * A message this client sent that the session does not show yet: shown
 * at once, replaced by its item when that arrives, kept with its command
 * id when sending failed so resending cannot deliver it twice.
 */
export interface PendingAgentMessage {
  commandId: string;
  text: string;
  attachments: AgentChatAttachment[];
  dispatch: "queue" | "steer" | "interrupt";
  status: "sending" | "sent" | "failed";
  /** The item the server created for it, once the receipt says. */
  itemId?: string;
  error?: CatamorphicError;
}

export interface AgentAuthenticationRequired {
  environment: string;
  requirements: Array<{
    alias: string;
    providerKind: string;
    principalKinds: Array<"member" | "project_service" | "tenant_service">;
  }>;
}

export interface SendOptions {
  /** Default: queue (core steers a reply to a waiting question itself). */
  dispatch?: "queue" | "steer" | "interrupt";
}

export interface UseAgentChatResult {
  sessionId: string | null;
  /** The session row, kept live; null before the first message creates it. */
  session: AgentSessionInfo | null;
  /** The folded event log, for the protocol's selectors. */
  state: SessionState | null;
  /** Turns as the conversation reads, oldest first. */
  timeline: TimelineTurn[];
  /** Turns waiting to run, in order: editable until they start. */
  queue: QueuedMessage[];
  /** Sent messages the session does not show yet, and failed sends. */
  pending: PendingAgentMessage[];
  /** The turn the agent works on now. */
  activeTurn: Turn | null;
  /** The turn about to start while nothing runs: it reads in the timeline. */
  startingTurn: Turn | null;
  /** Questions, approvals and elicitations waiting on an answer. */
  requests: RuntimeRequest[];
  isLoading: boolean;
  /** A command of this client's is on its way. */
  isSending: boolean;
  /** A turn is in flight: preparing, running, waiting or finalizing. */
  isWorking: boolean;
  /** The agent's live line, or what this client is doing; never a guess. */
  activity: string | undefined;
  connection: AgentSessionConnection;
  /** The stream dropped: the agent may still be working. */
  connectionLost: boolean;
  error: CatamorphicError | null;
  /** Missing member credentials that blocked starting the chat. */
  authenticationRequired: AgentAuthenticationRequired | null;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => Promise<void>;
  send: (
    text: string,
    attachments?: AgentChatAttachment[],
    options?: SendOptions,
  ) => Promise<CommandReceipt | null>;
  /** Stop the active turn and run this message next. */
  sendNow: (
    text: string,
    attachments?: AgentChatAttachment[],
  ) => Promise<CommandReceipt | null>;
  resendFailed: (commandId: string) => Promise<void>;
  dismissFailed: (commandId: string) => void;
  /** Change a queued message's text; keeps its attachments. */
  editQueued: (turnId: string, text: string) => Promise<boolean>;
  /**
   * Hold a queued turn while it is edited (null releases the held one),
   * so it does not start under the person's cursor.
   */
  holdQueued: (turnId: string | null) => Promise<boolean>;
  cancelQueued: (turnId: string) => Promise<boolean>;
  /** Run a queued turn now: it goes next and stops the active one. */
  sendQueuedNow: (turnId: string) => Promise<boolean>;
  /**
   * Stop a turn: the active one by default, or the turn named (one
   * waiting to retry stops as interrupted).
   */
  interrupt: (turnId?: string) => Promise<boolean>;
  /** Run a failed or interrupted turn again; default the latest one. */
  retry: (turnId?: string) => Promise<boolean>;
  /** Answer a question, an approval or an elicitation. */
  respond: (
    requestId: string,
    response: RuntimeRequestResponse,
  ) => Promise<boolean>;
  /** Undo a turn and every later one: files and conversation. */
  rollback: (turnId: string) => Promise<boolean>;
  /** Resume the blocked first message after the member authorizes access. */
  resumeAfterAuthentication: () => void;
  /**
   * The session's id, creating the session first when the chat has none
   * yet: for a chat that starts somewhere other than a message, such as
   * by voice. Null without a project, or once the chat moved on.
   */
  ensureSession: () => Promise<string | null>;
  startNewSession: () => void;
}

/**
 * Headless agent chat (ADR 0197): the live session, the conversation as
 * turns, and every command a person sends, each with its own command id.
 * Hosts own the presentation. The server's turn queue is the only queue.
 */
export function useAgentChat(
  projectId: string | undefined,
  options: UseAgentChatOptions = {},
): UseAgentChatResult {
  const controlledSessionId = options.sessionId ?? null;
  const [scope, setScope] = useState(() => ({
    projectId,
    controlledSessionId,
    sessionId: controlledSessionId,
    token: {},
  }));
  // A controlled id that echoes the session this hook just created is the
  // same conversation: keep its pending messages instead of resetting.
  if (
    scope.projectId !== projectId ||
    scope.controlledSessionId !== controlledSessionId
  ) {
    const adopted =
      projectId === scope.projectId &&
      controlledSessionId !== null &&
      controlledSessionId === scope.sessionId;
    setScope({
      projectId,
      controlledSessionId,
      sessionId: controlledSessionId,
      token: adopted ? scope.token : {},
    });
  }
  const sessionId = scope.projectId === projectId ? scope.sessionId : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const createSession = useCreateAgentSession(projectId);
  const live = useAgentSession(projectId, sessionId ?? undefined, {
    live: options.live ?? true,
  });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [pendingByScope, setPending] = useState<{
    token: object;
    items: PendingAgentMessage[];
  }>({ token: scope.token, items: [] });
  const pending =
    pendingByScope.token === scope.token ? pendingByScope.items : [];
  const updatePending = useCallback(
    (
      token: object,
      update: (items: PendingAgentMessage[]) => PendingAgentMessage[],
    ) =>
      setPending((current) => {
        const items = current.token === token ? current.items : [];
        return { token, items: update(items) };
      }),
    [],
  );
  const [errorByScope, setErrorState] = useState<{
    token: object;
    error: CatamorphicError | null;
  }>({ token: scope.token, error: null });
  const actionError =
    errorByScope.token === scope.token ? errorByScope.error : null;
  const setError = useCallback(
    (token: object, error: CatamorphicError | null) =>
      setErrorState({ token, error }),
    [],
  );
  const [inFlight, setInFlight] = useState(0);
  const blockedRef = useRef<{
    token: object;
    send: PendingAgentMessage;
  } | null>(null);
  const creationRef = useRef<{
    token: object;
    promise: Promise<string | null>;
  } | null>(null);
  const heldRef = useRef<string | null>(null);

  // A pending message leaves once the session shows its item.
  const state = live.state;
  useEffect(() => {
    if (!state || pending.length === 0) return;
    const shown = new Set<string>();
    for (const message of pending) {
      if (state.items.some((item) => isItemOf(item, message)))
        shown.add(message.commandId);
    }
    if (shown.size > 0)
      updatePending(scope.token, (items) =>
        items.filter((message) => !shown.has(message.commandId)),
      );
  }, [state, pending, scope.token, updatePending]);

  const ensureSessionId = async (token: object): Promise<string | null> => {
    if (!projectId) return null;
    const current = scopeRef.current;
    if (current.token !== token) return null;
    if (current.sessionId) return current.sessionId;
    if (creationRef.current?.token !== token) {
      const promise = createSession
        .mutateAsync({
          ...(optionsRef.current.agentId
            ? { agentId: optionsRef.current.agentId }
            : {}),
          ...(optionsRef.current.model
            ? { model: optionsRef.current.model }
            : {}),
          ...(optionsRef.current.effort
            ? { effort: optionsRef.current.effort }
            : {}),
          ...(optionsRef.current.environment
            ? { environment: optionsRef.current.environment }
            : {}),
          ...(optionsRef.current.source
            ? { source: optionsRef.current.source }
            : {}),
        })
        .then((created) => {
          if (scopeRef.current.token !== token) return null;
          const next = { ...scopeRef.current, sessionId: created.id };
          scopeRef.current = next;
          setScope(next);
          optionsRef.current.onSessionCreated?.(created.id);
          return created.id;
        })
        .finally(() => {
          if (creationRef.current?.token === token) creationRef.current = null;
        });
      creationRef.current = { token, promise };
    }
    return creationRef.current.promise;
  };

  // Without a live stream, a command's effect shows on the next snapshot.
  const connectionRef = useRef(live.connection);
  connectionRef.current = live.connection;
  const refreshUnlessStreaming = (target: string) => {
    if (connectionRef.current === "live" || !projectId) return;
    void queryClient.invalidateQueries({
      queryKey: agentSessionQueryKey(projectId, target),
      exact: true,
    });
  };

  /** Run one command on the current session; errors land on the chat. */
  const run = async (
    command: SessionCommandInput,
    commandId?: string,
  ): Promise<CommandReceipt | null> => {
    const token = scopeRef.current.token;
    const target = scopeRef.current.sessionId;
    if (!projectId || !target) return null;
    setError(token, null);
    setInFlight((count) => count + 1);
    try {
      const receipt = await sendSessionCommand({
        apiClient,
        projectId,
        sessionId: target,
        command,
        ...(commandId ? { commandId } : {}),
      });
      refreshUnlessStreaming(target);
      return receipt;
    } catch (error) {
      if (scopeRef.current.token === token)
        setError(token, toCatamorphicError({ cause: error }));
      return null;
    } finally {
      setInFlight((count) => count - 1);
    }
  };

  const deliver = async (
    message: PendingAgentMessage,
  ): Promise<CommandReceipt | null> => {
    if (!projectId) return null;
    const token = scopeRef.current.token;
    setError(token, null);
    updatePending(token, (items) => [
      ...items.filter((item) => item.commandId !== message.commandId),
      { ...message, status: "sending", error: undefined },
    ]);
    setInFlight((count) => count + 1);
    try {
      const target = await ensureSessionId(token);
      if (!target || scopeRef.current.token !== token) return null;
      const receipt = await sendSessionCommand({
        apiClient,
        projectId,
        sessionId: target,
        commandId: message.commandId,
        command: {
          type: "send",
          text: message.text,
          ...(message.attachments.length > 0
            ? { attachments: message.attachments }
            : {}),
          ...(message.dispatch !== "queue"
            ? { dispatch: message.dispatch }
            : {}),
        },
      });
      blockedRef.current = null;
      refreshUnlessStreaming(target);
      const itemId =
        typeof receipt.result?.itemId === "string"
          ? receipt.result.itemId
          : undefined;
      updatePending(token, (items) =>
        items.map((item) =>
          item.commandId === message.commandId
            ? { ...item, status: "sent", ...(itemId ? { itemId } : {}) }
            : item,
        ),
      );
      return receipt;
    } catch (cause) {
      if (scopeRef.current.token !== token) return null;
      const error = toCatamorphicError({ cause });
      if (
        error.code === "authentication_required" &&
        !scopeRef.current.sessionId
      ) {
        // Starting the chat was refused before anything was accepted:
        // keep the message to send once the member authorizes access.
        setError(token, error);
        blockedRef.current = { token, send: message };
        updatePending(token, (items) =>
          items.filter((item) => item.commandId !== message.commandId),
        );
      }
      // The failure is the message's own: it stays, unsent, with why.
      else
        updatePending(token, (items) =>
          items.map((item) =>
            item.commandId === message.commandId
              ? { ...item, status: "failed", error }
              : item,
          ),
        );
      return null;
    } finally {
      setInFlight((count) => count - 1);
    }
  };

  const send: UseAgentChatResult["send"] = (text, attachments, sendOptions) => {
    const trimmed = text.trim();
    if (!trimmed && (attachments?.length ?? 0) === 0)
      return Promise.resolve(null);
    return deliver({
      commandId: randomId(),
      text: trimmed,
      attachments: attachments ?? [],
      dispatch: sendOptions?.dispatch ?? "queue",
      status: "sending",
    });
  };

  const turns = state ? Object.values(state.turns) : [];
  const active = state ? (activeTurnOf(state) ?? null) : null;
  const starting = state ? (startingTurn(state) ?? null) : null;
  const queue = state ? sessionQueue(state) : [];
  const working = active !== null;
  const latestRetryable = [...turns]
    .sort((a, b) => b.ordinal - a.ordinal)
    .find((turn) => turn.status === "failed" || turn.status === "interrupted");

  // Release a held turn when the host stops editing without saving.
  const holdQueued: UseAgentChatResult["holdQueued"] = async (turnId) => {
    const target = turnId ?? heldRef.current;
    if (!target) return false;
    heldRef.current = turnId;
    const receipt = await run({
      type: "edit_queued",
      turnId: target,
      held: turnId !== null,
    });
    return receipt !== null;
  };

  const connectionLost = live.connection === "reconnecting";
  const sending = inFlight > 0;
  const error = actionError ?? live.error;
  const timeline = state ? sessionTimeline(state) : [];

  return {
    sessionId,
    session: live.session,
    state,
    timeline,
    queue,
    pending,
    activeTurn: active,
    startingTurn: starting,
    requests: state ? pendingRequests(state) : [],
    isLoading: live.isLoading,
    isSending: sending,
    isWorking: working,
    activity: connectionLost
      ? undefined
      : active
        ? turnActivity(active)
        : sending
          ? "Sending message"
          : starting
            ? "Waiting for agent"
            : undefined,
    connection: live.connection,
    connectionLost,
    error,
    authenticationRequired: authenticationRequiredFrom(error),
    hasOlder: live.hasOlder,
    isLoadingOlder: live.isLoadingOlder,
    loadOlder: live.loadOlder,
    send,
    sendNow: (text, attachments) =>
      send(text, attachments, { dispatch: "interrupt" }),
    resendFailed: async (commandId) => {
      const failed = pending.find(
        (message) =>
          message.commandId === commandId && message.status === "failed",
      );
      if (failed) await deliver(failed);
    },
    dismissFailed: (commandId) =>
      updatePending(scope.token, (items) =>
        items.filter((item) => item.commandId !== commandId),
      ),
    editQueued: async (turnId, text) => {
      const queued = queue.find((entry) => entry.turn.id === turnId);
      if (!queued) return false;
      const attachmentCount = queued.item?.attachments.length ?? 0;
      if (heldRef.current === turnId) heldRef.current = null;
      const receipt = await run({
        type: "edit_queued",
        turnId,
        text: withMarkerCount(text, attachmentCount),
        held: false,
      });
      return receipt !== null;
    },
    holdQueued,
    cancelQueued: async (turnId) => {
      if (heldRef.current === turnId) heldRef.current = null;
      return (await run({ type: "cancel_queued", turnId })) !== null;
    },
    sendQueuedNow: async (turnId) => {
      if (heldRef.current === turnId) heldRef.current = null;
      return (await run({ type: "send_now", turnId })) !== null;
    },
    interrupt: async (turnId) => {
      const target = turnId ?? active?.id;
      return (
        (await run({
          type: "interrupt",
          ...(target ? { turnId: target } : {}),
        })) !== null
      );
    },
    retry: async (turnId) => {
      const target = turnId ?? latestRetryable?.id;
      if (!target) return false;
      return (await run({ type: "retry", turnId: target })) !== null;
    },
    respond: async (requestId, response) =>
      (await run({ type: "respond", requestId, response })) !== null,
    rollback: async (turnId) => {
      const receipt = await run({ type: "rollback", turnId });
      if (receipt && projectId && sessionId)
        // The workspace moved: anything showing files reads them again.
        void queryClient.invalidateQueries({
          queryKey: ["cat", "project", projectId],
          predicate: (query) =>
            query.queryKey.join("/") !==
            agentSessionQueryKey(projectId, sessionId).join("/"),
        });
      return receipt !== null;
    },
    resumeAfterAuthentication: () => {
      const blocked = blockedRef.current;
      if (blocked && blocked.token === scopeRef.current.token)
        void deliver(blocked.send);
    },
    ensureSession: () => ensureSessionId(scopeRef.current.token),
    startNewSession: () => {
      if (inFlight > 0) return;
      blockedRef.current = null;
      creationRef.current = null;
      heldRef.current = null;
      const next = {
        projectId,
        controlledSessionId,
        sessionId: null,
        token: {},
      };
      scopeRef.current = next;
      setScope(next);
    },
  };
}

/** The active turn's line: its own words, or what stage it is at. */
export function turnActivity(turn: Turn): string {
  if (turn.cancellationRequested) return "Stopping agent";
  if (turn.activity) return turn.activity;
  switch (turn.status) {
    case "preparing":
      return "Starting agent";
    case "waiting":
      return "Waiting for you";
    case "finalizing":
      return "Saving changes";
    default:
      return "Working";
  }
}

/** Whether an item is the one a pending message became. */
function isItemOf(item: Item, message: PendingAgentMessage): boolean {
  if (message.itemId && item.id === message.itemId) return true;
  return (
    item.kind === "user_message" &&
    item.idempotencyKey !== null &&
    item.idempotencyKey.endsWith(`:${message.commandId}`)
  );
}

/**
 * Edited text keeps one inline marker per attachment: pills the person
 * removed while editing come back at the end rather than going missing.
 */
function withMarkerCount(text: string, attachments: number): string {
  const withoutMarkers = text.split(ATTACHMENT_MARKER).join("");
  const markers =
    (text.length - withoutMarkers.length) / ATTACHMENT_MARKER.length;
  return markers === attachments
    ? text
    : withoutMarkers + ATTACHMENT_MARKER.repeat(attachments);
}

export function authenticationRequiredFrom(
  error: unknown,
): AgentAuthenticationRequired | null {
  if (
    !(error instanceof CatamorphicError) ||
    error.code !== "authentication_required"
  )
    return null;
  const details = error.details;
  if (details === null || typeof details !== "object") return null;
  if (!("environment" in details) || typeof details.environment !== "string")
    return null;
  if (!("requirements" in details) || !Array.isArray(details.requirements))
    return null;
  const requirements: AgentAuthenticationRequired["requirements"] = [];
  for (const raw of details.requirements) {
    if (raw === null || typeof raw !== "object") return null;
    if (
      !("alias" in raw) ||
      typeof raw.alias !== "string" ||
      !("providerKind" in raw) ||
      typeof raw.providerKind !== "string" ||
      !("principalKinds" in raw) ||
      !Array.isArray(raw.principalKinds)
    )
      return null;
    const kinds: unknown[] = raw.principalKinds;
    const principalKinds = kinds.filter(
      (kind): kind is "member" | "project_service" | "tenant_service" =>
        kind === "member" ||
        kind === "project_service" ||
        kind === "tenant_service",
    );
    if (principalKinds.length !== kinds.length) return null;
    requirements.push({
      alias: raw.alias,
      providerKind: raw.providerKind,
      principalKinds,
    });
  }
  return { environment: details.environment, requirements };
}
