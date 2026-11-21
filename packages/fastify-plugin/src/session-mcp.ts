import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type CatamorphicCore,
  hasTokenScope,
  type Identity,
  parseWaitCursor,
  SESSION_OPERATIONS,
  type SessionState,
  SessionStateSchema,
  type SessionWait,
  sessionOperationError,
} from "@catamorphic/core";
import { z } from "zod";
import {
  declaresElicitation,
  declaresTasks,
  MCP_ERROR,
  type McpCallContext,
  McpError,
  type McpResources,
  type McpTasks,
  type McpTool,
  type McpToolResult,
  type McpWatch,
} from "./mcp-server.js";
import {
  ATTENTION_RESOURCE_URI,
  sessionResourceUri,
  sessionToolAuthor,
  sessionToolError,
  sessionToolResult,
  sessionTools,
} from "./session-tools.js";

/**
 * What the current protocol adds to the session tools (ADR 0345): a chat
 * as a resource a client can read and listen to, a wait as a durable task,
 * and an agent's question asked of the client's person in the same call.
 * All three are conveniences over the plain tools, which every client can
 * use: nothing here is the only way to do anything.
 */

/** How long a client may take to answer what a wait asked it. */
const REQUEST_STATE_TTL_MS = 30 * 60_000;
/** How often a client should look at a task again. */
const TASK_POLL_INTERVAL_MS = 2_000;
/** A task is answered inline when its wait ends within this. */
const TASK_INLINE_WAIT_SECONDS = 2;

type Request = SessionState["requests"][number];

/**
 * A request as the form a client shows its person, or nothing when it
 * cannot be asked that way (an approval without the scope, a URL).
 */
export function elicitationFor(
  request: Request,
  options: { mayApprove: boolean },
): Record<string, unknown> | undefined {
  const form = (message: string, requestedSchema: Record<string, unknown>) => ({
    method: "elicitation/create",
    params: { mode: "form", message, requestedSchema },
  });
  if (request.kind === "question" && request.questions?.length) {
    const properties: Record<string, unknown> = {};
    request.questions.forEach((question, index) => {
      const labels = question.options.map((option) => option.label);
      const described = {
        title: question.header || `Question ${index + 1}`,
        description: question.question,
      };
      properties[`answer${index + 1}`] =
        labels.length === 0
          ? { type: "string", ...described }
          : question.multiSelect
            ? {
                type: "array",
                ...described,
                minItems: 1,
                items: { type: "string", enum: labels },
              }
            : { type: "string", ...described, enum: labels };
    });
    return form(request.title || "The agent has a question", {
      type: "object",
      properties,
      required: Object.keys(properties),
    });
  }
  if (request.kind === "approval" && request.approval && options.mayApprove)
    return form(
      [request.title, request.approval.action, request.approval.details]
        .filter(Boolean)
        .join("\n"),
      {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Decision",
            description:
              "always: approve, and allow this tool from now on without asking",
            enum: ["approve", "deny", "always"],
          },
        },
        required: ["decision"],
      },
    );
  if (request.kind === "elicitation" && request.elicitation?.schema)
    return form(request.elicitation.message, request.elicitation.schema);
  return undefined;
}

const Elicited = z.looseObject({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A person's answer to a form as the response the chat's request takes,
 * or nothing when they declined: the request stays open in the chat.
 */
export function responseFor(
  request: Request,
  answer: unknown,
): Record<string, unknown> | undefined {
  const elicited = Elicited.safeParse(answer);
  if (!elicited.success) return undefined;
  const content = elicited.data.content ?? {};
  if (request.kind === "elicitation")
    return {
      kind: "elicitation",
      action: elicited.data.action,
      ...(elicited.data.action === "accept" ? { content } : {}),
    };
  if (elicited.data.action !== "accept") return undefined;
  if (request.kind === "approval") {
    const decision = content.decision;
    if (decision !== "approve" && decision !== "deny" && decision !== "always")
      return undefined;
    return {
      kind: "approval",
      decision: decision === "deny" ? "denied" : "approved",
      ...(decision === "always" ? { remember: "always" } : {}),
    };
  }
  const answers = (request.questions ?? []).map((_question, index) => {
    const value = content[`answer${index + 1}`];
    return Array.isArray(value) ? value.map(String).join(", ") : value;
  });
  if (answers.some((value) => typeof value !== "string" || value === ""))
    return undefined;
  return { kind: "question", answers };
}

const RequestState = z.object({
  /** The member the state was handed to. */
  sub: z.string(),
  tool: z.literal("session_wait"),
  sessions: z.array(z.string()),
  requests: z.array(z.string()),
  exp: z.number(),
});
type RequestStatePayload = z.infer<typeof RequestState>;

/**
 * The state a wait hands out with what it asks (MRTR): who was asked, for
 * which chats and requests, and until when, under an HMAC. A client only
 * echoes it; anything else fails here.
 */
export function signRequestState(
  payload: RequestStatePayload,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyRequestState(
  state: string,
  expected: { sub: string; sessions: readonly string[]; secret: string },
): RequestStatePayload {
  const refuse = () =>
    new McpError(
      MCP_ERROR.invalidParams,
      "Invalid or expired requestState: call session_wait again without it.",
      { status: 400 },
    );
  const [body, mac, ...rest] = state.split(".");
  if (!body || !mac || rest.length > 0) throw refuse();
  const wanted = createHmac("sha256", expected.secret).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
    throw refuse();
  let payload: RequestStatePayload;
  try {
    payload = RequestState.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
  } catch {
    throw refuse();
  }
  if (
    payload.sub !== expected.sub ||
    payload.exp <= Date.now() ||
    [...payload.sessions].sort().join() !== [...expected.sessions].sort().join()
  )
    throw refuse();
  return payload;
}

const WaitArgs = SESSION_OPERATIONS.session_wait.input;
const WaitResult = SESSION_OPERATIONS.session_wait.output;

/**
 * The session tools with what the current protocol adds, the chats as
 * resources, and waits as tasks, for one caller. `projectId` binds them
 * to a project; without it they serve every project the caller may use.
 */
export function sessionMcp(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId?: string;
  currentSessionId?: string;
  /** Signs the state a wait hands out; the same on every replica. */
  stateSecret: string;
}): { tools: McpTool[]; resources: McpResources; tasks: McpTasks } | undefined {
  const { core, identity } = args;
  const operations = core.sessionOperations;
  const sessions = core.agentSessions;
  if (!operations || !sessions) return undefined;
  const principal = `${identity.tenantId}:${identity.externalUserId}`;
  const mayApprove = hasTokenScope(identity, "sessions:approve");
  const projectOf = async (sessionId: string) =>
    args.projectId ??
    (await sessions.projectOfSession({ identity, sessionId }));

  const run = async (
    operation: "session_wait" | "session_answer",
    input: unknown,
    signal?: AbortSignal,
  ) =>
    operations.execute({
      identity,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      operation,
      args: input,
      ...(await sessionToolAuthor({
        core,
        identity,
        projectId: args.projectId,
        currentSessionId: args.currentSessionId,
      })),
      ...(signal ? { signal } : {}),
    });

  /** The forms for what these chats ask, by request id. */
  const asks = (states: readonly SessionState[]) => {
    const inputRequests: Record<string, unknown> = {};
    for (const state of states)
      for (const request of state.requests) {
        const form = request.blocking
          ? elicitationFor(request, { mayApprove })
          : undefined;
        if (form) inputRequests[request.requestId] = form;
      }
    return inputRequests;
  };

  /** Answer the chats' requests a client's person filled in. */
  const answer = async (
    states: readonly SessionState[],
    inputResponses: Record<string, unknown>,
    salt: string,
  ) => {
    for (const state of states)
      for (const request of state.requests) {
        if (!(request.requestId in inputResponses)) continue;
        const response = responseFor(
          request,
          inputResponses[request.requestId],
        );
        if (!response) continue;
        await run("session_answer", {
          sessionId: state.sessionId,
          requestId: request.requestId,
          response,
          idempotencyKey: `${salt}:${request.requestId}`,
        });
      }
  };

  const statesOf = async (sessionIds: readonly string[]) => {
    const chats = [];
    for (const sessionId of sessionIds)
      chats.push({ projectId: await projectOf(sessionId), sessionId });
    return sessions.states(identity, { sessions: chats, detail: true });
  };

  /** The wait tool's answer, as plain tools give it. */
  const waited = (value: unknown): McpToolResult => {
    const shaped = WaitResult.safeParse(value);
    const result = sessionToolResult(shaped.success ? shaped.data : value);
    // A failed turn is a result the caller reads, flagged as an error.
    return shaped.success && shaped.data.state === "failed"
      ? { ...result, isError: true }
      : result;
  };

  const base = sessionTools(args);
  const tools = base.map((tool): McpTool => {
    if (tool.definition.name !== "session_wait") return tool;
    return {
      ...tool,
      call: async (input, context?: McpCallContext) => {
        const parsed = WaitArgs.safeParse(input);
        if (!parsed.success) return sessionToolError(parsed.error);
        let wait = parsed.data;
        try {
          if (context?.requestState !== undefined) {
            const state = verifyRequestState(context.requestState, {
              sub: principal,
              sessions: wait.sessionIds,
              secret: args.stateSecret,
            });
            await answer(
              (await statesOf(wait.sessionIds)).map((chat) => ({
                ...chat,
                requests: chat.requests.filter((request) =>
                  state.requests.includes(request.requestId),
                ),
              })),
              context.inputResponses ?? {},
              `mrtr:${state.exp}`,
            );
            // What was asked is answered or declined: wait for what is next.
            wait = {
              ...wait,
              cursor: undefined,
              ...(Object.keys(context.inputResponses ?? {}).length === 0
                ? { onInput: "return" as const }
                : {}),
            };
          }
          if (declaresTasks(context)) {
            const quick = SessionStateSchema.extend({
              changed: z.boolean(),
            }).parse(
              await run(
                "session_wait",
                { ...wait, timeoutSeconds: TASK_INLINE_WAIT_SECONDS },
                context?.signal,
              ),
            );
            if (quick.changed && quick.state !== "needs_input")
              return waited(quick);
            const after = parseWaitCursor(quick.cursor, wait.sessionIds);
            const watched = [];
            for (const sessionId of new Set(wait.sessionIds))
              watched.push({
                projectId: await projectOf(sessionId),
                sessionId,
                // A chat that asks now is the task's first thing to say.
                ...(quick.state === "needs_input"
                  ? {}
                  : { after: after.get(sessionId) ?? 0 }),
              });
            return taskOf(
              await core.sessionWaits.create({ identity, sessions: watched }),
              { status: "working", resultType: "task" },
            );
          }
          const value = SessionStateSchema.extend({
            changed: z.boolean(),
          }).parse(await run("session_wait", wait, context?.signal));
          if (
            value.state === "needs_input" &&
            wait.onInput === "ask" &&
            declaresElicitation(context)
          ) {
            const states = await statesOf(wait.sessionIds);
            const inputRequests = asks(states);
            if (Object.keys(inputRequests).length > 0)
              return {
                resultType: "input_required",
                inputRequests,
                requestState: signRequestState(
                  {
                    sub: principal,
                    tool: "session_wait",
                    sessions: [...wait.sessionIds],
                    requests: Object.keys(inputRequests),
                    exp: Date.now() + REQUEST_STATE_TTL_MS,
                  },
                  args.stateSecret,
                ),
              };
          }
          return waited(value);
        } catch (error) {
          if (error instanceof McpError) throw error;
          return sessionToolError(error);
        }
      },
    };
  });

  const taskOf = (
    wait: SessionWait,
    fields: Record<string, unknown>,
  ): Record<string, unknown> => ({
    taskId: wait.id,
    createdAt: wait.createdAt,
    lastUpdatedAt: wait.updatedAt,
    ttlMs: Date.parse(wait.expiresAt) - Date.parse(wait.createdAt),
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
    ...fields,
  });
  const unknownTask = () =>
    new McpError(MCP_ERROR.invalidParams, "Unknown task", { status: 404 });

  /** A task as it stands now: what its wait came to, or what it asks. */
  const task = async (taskId: string): Promise<Record<string, unknown>> => {
    const wait = await core.sessionWaits.get({ identity, id: taskId });
    if (!wait) throw unknownTask();
    if (wait.status === "cancelled")
      return taskOf(wait, { status: "cancelled" });
    if (wait.status === "completed")
      return taskOf(wait, { status: "completed", result: wait.outcome });
    try {
      const hit = await sessions.waitFor(identity, {
        sessions: wait.sessions,
        timeoutMs: 0,
      });
      const states = await sessions.states(identity, {
        sessions: wait.sessions,
        detail: true,
      });
      const asking = states.filter((state) => state.state === "needs_input");
      const inputRequests = asks(asking);
      if (Object.keys(inputRequests).length > 0)
        return taskOf(wait, {
          status: "input_required",
          statusMessage: "An agent is waiting for an answer",
          inputRequests,
        });
      const first = states.find((state) => state.sessionId === hit);
      if (!first)
        return taskOf(wait, {
          status: "working",
          statusMessage:
            states
              .map((state) => state.waiting?.message ?? state.turn?.activity)
              .find((line) => typeof line === "string" && line !== "") ??
            "Working",
        });
      const others = states.filter((state) => state !== first);
      const outcome = waited({
        ...first,
        changed: true,
        cursor:
          states.length === 1
            ? first.cursor
            : states
                .map((state) => `${state.sessionId}:${state.cursor}`)
                .join(","),
        ...(others.length
          ? {
              others: others.map((state) => ({
                sessionId: state.sessionId,
                state: state.state,
                cursor: state.cursor,
              })),
            }
          : {}),
      });
      const done = await core.sessionWaits.complete({
        identity,
        id: wait.id,
        outcome,
      });
      // Whoever recorded the outcome first is what everyone reads.
      return done?.status === "completed"
        ? taskOf(done, { status: "completed", result: done.outcome })
        : done
          ? taskOf(done, { status: done.status })
          : taskOf(wait, { status: "completed", result: outcome });
    } catch (error) {
      // What the chats can no longer say (closed to the caller, gone) is
      // the task's own result, as a failed tool call is.
      const outcome = sessionToolError(error);
      const done = await core.sessionWaits.complete({
        identity,
        id: wait.id,
        outcome,
      });
      return taskOf(done ?? wait, {
        status: "completed",
        result: done?.outcome ?? outcome,
      });
    }
  };

  const tasks: McpTasks = {
    get: task,
    update: async (taskId, inputResponses) => {
      const wait = await core.sessionWaits.get({ identity, id: taskId });
      if (!wait) throw unknownTask();
      if (wait.status !== "working") return;
      await answer(
        await sessions.states(identity, {
          sessions: wait.sessions,
          detail: true,
        }),
        inputResponses,
        `task:${wait.id}`,
      ).catch((error: unknown) => {
        throw new McpError(
          MCP_ERROR.invalidParams,
          sessionOperationError(error).message,
        );
      });
    },
    // Only the watching ends: the agent works on, and its chat is there
    // to wait on again.
    cancel: async (taskId) => {
      if (!(await core.sessionWaits.cancel({ identity, id: taskId })))
        throw unknownTask();
    },
    watch: async (taskIds, changed) => {
      const seen = new Map<string, string>();
      const accepted: string[] = [];
      for (const taskId of taskIds)
        if (await core.sessionWaits.get({ identity, id: taskId }))
          accepted.push(taskId);
      let stopped = false;
      const look = async () => {
        for (const taskId of accepted) {
          if (stopped) return;
          const state = await task(taskId).catch(() => undefined);
          if (!state) continue;
          const print = JSON.stringify([
            state.status,
            Object.keys(
              typeof state.inputRequests === "object" && state.inputRequests
                ? state.inputRequests
                : {},
            ),
          ]);
          if (seen.get(taskId) === print) continue;
          const first = !seen.has(taskId);
          seen.set(taskId, print);
          // A listener hears what changes after it started listening.
          if (!first || state.status !== "working") changed(state);
        }
      };
      await look();
      const timer = setInterval(() => void look(), TASK_POLL_INTERVAL_MS);
      timer.unref?.();
      return {
        accepted,
        stop: () => {
          stopped = true;
          clearInterval(timer);
        },
      };
    },
  };

  const attention = async () => {
    const waiting = (await sessions.attention({ identity })).filter(
      (session) => !args.projectId || session.projectId === args.projectId,
    );
    return sessions.states(identity, {
      sessions: waiting.map((session) => ({
        projectId: session.projectId,
        sessionId: session.id,
      })),
      detail: false,
      listed: true,
    });
  };
  const sessionIdOf = (uri: string) =>
    /^work:\/\/sessions\/([0-9a-f-]{36})$/i.exec(uri)?.[1];
  const notFound = (uri: string) =>
    new McpError(MCP_ERROR.invalidParams, `Resource not found: ${uri}`, {
      data: { uri },
    });
  const json = (uri: string, value: unknown) => [
    { uri, mimeType: "application/json", text: JSON.stringify(value) },
  ];

  const resources: McpResources = {
    list: async () => [
      {
        uri: ATTENTION_RESOURCE_URI,
        name: "attention",
        title: "Chats that need you",
        description:
          "The chats waiting on you: an agent asked something, or a turn failed. Listen to it to hear when one does.",
        mimeType: "application/json",
      },
    ],
    templates: async () => [
      {
        uriTemplate: sessionResourceUri("{sessionId}"),
        name: "session",
        title: "A chat's state",
        description:
          "One chat as session_read returns it. Listen to it to hear when it changes.",
        mimeType: "application/json",
      },
    ],
    read: async (uri) => {
      if (uri === ATTENTION_RESOURCE_URI)
        return json(uri, { sessions: await attention() });
      const sessionId = sessionIdOf(uri);
      if (!sessionId) throw notFound(uri);
      const [state] = await statesOf([sessionId]).catch(() => []);
      if (!state) throw notFound(uri);
      return json(uri, state);
    },
    watch: async (uris, changed, ended) => {
      const stops: Array<() => void> = [];
      const accepted: string[] = [];
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      // A burst of events is one change to whoever listens.
      const soon = (uri: string) => {
        if (timers.has(uri)) return;
        timers.set(
          uri,
          setTimeout(() => {
            timers.delete(uri);
            changed(uri);
          }, 250),
        );
      };
      for (const uri of new Set(uris)) {
        if (uri === ATTENTION_RESOURCE_URI) {
          const print = async () =>
            JSON.stringify(
              (await sessions.attention({ identity }))
                .filter(
                  (session) =>
                    !args.projectId || session.projectId === args.projectId,
                )
                .map((session) => [session.id, session.attentionRevision]),
            );
          let last = await print();
          const timer = setInterval(() => {
            void print()
              .then((next) => {
                if (next === last) return;
                last = next;
                changed(uri);
              })
              .catch(() => {});
          }, 2_000);
          timer.unref?.();
          stops.push(() => clearInterval(timer));
          accepted.push(uri);
          continue;
        }
        const sessionId = sessionIdOf(uri);
        const [state] = sessionId
          ? await statesOf([sessionId]).catch(() => [])
          : [];
        if (!sessionId || !state) continue;
        stops.push(
          await sessions.subscribe(identity, state.projectId, sessionId, {
            after: Number(state.cursor),
            send: () => {
              soon(uri);
              return true;
            },
            // The caller may no longer read it, or the server is stopping.
            onClose: ended,
          }),
        );
        accepted.push(uri);
      }
      const watch: McpWatch = {
        accepted,
        stop: () => {
          for (const stop of stops) stop();
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
        },
      };
      return watch;
    },
  };

  return { tools, resources, tasks };
}
