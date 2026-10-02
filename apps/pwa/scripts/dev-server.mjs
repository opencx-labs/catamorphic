/*
 * A zero-dep fake Catamorphic server for pwa development and e2e: the
 * agent-session routes of ADR 0196 (session row + snapshot, the event
 * stream, commands with receipts, older item pages) with a scripted
 * agent, speaking the same wire shapes as @catamorphic/fastify-plugin.
 * Its minimal OAuth server authorizes immediately for deterministic local
 * development. Any issued bearer token resolves a scoped member of the
 * seeded project.
 *
 *   node scripts/dev-server.mjs          # port 8788 (PORT= to change)
 *
 * The scripted agent reads the message that starts a turn:
 *   "ask …"      → parks an approval request for a Slack tool call
 *   "question …" → asks a blocking question
 *   "fail …"     → fails the turn (Retry runs it again, and it works)
 *   anything     → a command, a file change and a markdown reply
 * A plain message sent while a blocking question waits steers into the
 * turn: the question stays open, no longer blocking (ADR 0195).
 * Set THEME=midnight (or light/paper) to serve a committed project theme.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const THEME = process.env.THEME;
const AGENT_PROTOCOL = { session: 1, runner: 1 };
const QUESTIONS_DISMISSED_MESSAGE =
  "The user dismissed these questions without answering them. Continue without their input, using your best judgment.";

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Brain",
  storageType: "managed",
  remoteUrl: null,
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** sessionId -> fake session: its row, projections and event log. */
const sessions = new Map();

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newSession(body) {
  const id = randomUUID();
  const at = now();
  const session = {
    row: {
      id,
      projectId: PROJECT.id,
      externalUserId: "member",
      owner: "member",
      source: "mobile",
      sandboxId: null,
      allocationId: null,
      environment: body.environment ?? "company",
      agentId: body.agentId ?? null,
      model: body.model ?? null,
      modelEffort: body.effort ?? null,
      title: body.title ?? null,
      icon: null,
      forkedFromSessionId: null,
      parentSessionId: body.parentSessionId ?? null,
      visibility: body.parentSessionId ? "latent" : "promoted",
      archivedAt: null,
      status: "active",
      workStatus: "open",
      stateRevision: 0,
      activity: null,
      todos: [],
      authorityHostId: "fake-host",
      authorityRevision: 1,
      authoritySeenAt: at,
      mirrorSequence: 0,
      handoffStatus: "none",
      handoffDestinationHostId: null,
      resumable: false,
      pausedAt: null,
      attentionRevision: 0,
      attentionSeenRevision: 0,
      attentionRequired: false,
      key: null,
      keyWorkflows: [],
      placement: null,
      workspace: null,
      baseCommitSha: null,
      createdAt: at,
      updatedAt: at,
    },
    sequence: 0,
    log: [],
    turns: new Map(),
    items: new Map(),
    requests: new Map(),
    /** commandId -> receipt, so a resent command is answered, not rerun. */
    receipts: new Map(),
    /** Open event streams. */
    listeners: new Set(),
    /** requestId -> resolve, for a turn waiting on an answer. */
    waiters: new Map(),
    /** turnId -> the text that started it, for the scripted agent. */
    prompts: new Map(),
    running: false,
  };
  sessions.set(id, session);
  return session;
}

const SESSION_FIELDS = [
  "id",
  "projectId",
  "title",
  "icon",
  "agentId",
  "model",
  "modelEffort",
  "status",
  "workStatus",
  "activity",
  "todos",
  "parentSessionId",
  "forkedFromSessionId",
  "attentionRevision",
  "environment",
  "authorityHostId",
  "authorityRevision",
  "handoffStatus",
  "updatedAt",
];

function sessionFields(session) {
  return Object.fromEntries(
    SESSION_FIELDS.map((field) => [field, session.row[field]]),
  );
}

function activeTurn(session) {
  return [...session.turns.values()].find((turn) =>
    ["preparing", "running", "waiting", "finalizing"].includes(turn.status),
  );
}

/** The session row as lists and the detail route answer it. */
function rowOf(session) {
  return { ...session.row, running: activeTurn(session) !== undefined };
}

function snapshotOf(session) {
  return {
    sequence: session.sequence,
    session: sessionFields(session),
    turns: [...session.turns.values()],
    attempts: [],
    items: [...session.items.values()].sort((a, b) => a.position - b.position),
    requests: [...session.requests.values()],
    providerThreads: [],
    olderBefore: null,
  };
}

/** Commit one event: update the projections, log it, stream it. */
function emit(session, event, commandId = null) {
  session.sequence += 1;
  const at = now();
  switch (event.type) {
    case "session.changed":
      Object.assign(session.row, event.session, { updatedAt: at });
      break;
    case "turn.changed":
      session.turns.set(event.turn.id, event.turn);
      break;
    case "item.added":
    case "item.changed": {
      const existing = session.items.get(event.item.id);
      const item = existing
        ? { ...event.item, position: existing.position }
        : { ...event.item, position: session.sequence };
      session.items.set(item.id, item);
      event = { ...event, item };
      break;
    }
    case "item.text_appended": {
      const item = session.items.get(event.itemId);
      if (item)
        session.items.set(item.id, { ...item, text: item.text + event.text });
      break;
    }
    case "request.changed":
      session.requests.set(event.request.id, event.request);
      break;
  }
  session.row.updatedAt = at;
  const stored = {
    sessionId: session.row.id,
    sequence: session.sequence,
    at,
    commandId,
    event,
  };
  session.log.push(stored);
  for (const listener of session.listeners)
    listener({ type: "events", events: [stored] }, stored.sequence);
  return stored;
}

function itemBase(session, turnId, kind) {
  const at = now();
  return {
    id: randomUUID(),
    sessionId: session.row.id,
    turnId,
    attemptId: null,
    parentItemId: null,
    position: 0,
    status: "completed",
    nativeRef: null,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    endedAt: at,
    kind,
  };
}

function addItem(session, turnId, kind, fields, commandId) {
  const item = { ...itemBase(session, turnId, kind), ...fields };
  emit(session, { type: "item.added", item }, commandId);
  return session.items.get(item.id);
}

function changeItem(session, item, fields) {
  const next = { ...session.items.get(item.id), ...fields, updatedAt: now() };
  emit(session, { type: "item.changed", item: next });
  return next;
}

function changeTurn(session, turnId, fields, commandId) {
  const turn = { ...session.turns.get(turnId), ...fields, updatedAt: now() };
  emit(session, { type: "turn.changed", turn }, commandId);
  return turn;
}

function newTurn(session, inputItemId, dispatch) {
  const ordinal = session.turns.size + 1;
  const at = now();
  return {
    id: randomUUID(),
    sessionId: session.row.id,
    ordinal,
    status: "queued",
    inputItemId,
    dispatch,
    priority: dispatch === "interrupt" ? 1 : 0,
    activity: null,
    activityAt: null,
    attemptCount: 0,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: at,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
  };
}

function userMessage({ text, attachments, dispatch, commandId, metadata }) {
  return {
    author: { kind: "user", externalUserId: "member" },
    text,
    attachments: attachments ?? [],
    dispatch,
    attention: null,
    idempotencyKey: commandId ? `command:${commandId}` : null,
    metadata: metadata ?? {},
  };
}

/** Queue a turn for `text` and start the queue. */
function enqueue(
  session,
  { text, attachments, dispatch, commandId, metadata },
) {
  const itemId = randomUUID();
  const turn = newTurn(
    session,
    itemId,
    dispatch === "interrupt" ? "interrupt" : "queue",
  );
  session.prompts.set(turn.id, text.trim());
  emit(session, { type: "turn.changed", turn }, commandId);
  const item = addItem(
    session,
    turn.id,
    "user_message",
    {
      id: itemId,
      ...userMessage({
        text,
        attachments,
        dispatch,
        commandId,
        metadata,
      }),
    },
    commandId,
  );
  if (dispatch === "interrupt") {
    const active = activeTurn(session);
    if (active) interruptTurn(session, active.id, commandId);
  }
  void drain(session);
  return { turnId: turn.id, itemId: item.id };
}

/** Run queued turns one at a time, highest priority first. */
async function drain(session) {
  if (session.running) return;
  session.running = true;
  try {
    for (;;) {
      const next = [...session.turns.values()]
        .filter((turn) => turn.status === "queued")
        .sort((a, b) => b.priority - a.priority || a.ordinal - b.ordinal)[0];
      if (!next) break;
      await runTurn(session, next.id);
    }
  } finally {
    session.running = false;
  }
}

function settled(session, turnId) {
  const status = session.turns.get(turnId)?.status;
  return status !== "running" && status !== "waiting" && status !== "preparing";
}

function finish(session, turnId, fields) {
  if (settled(session, turnId)) return;
  changeTurn(session, turnId, {
    status: "completed",
    activity: null,
    activeAttemptId: null,
    completedAt: now(),
    outcome: {
      changedFiles: [],
      usage: { inputTokens: 1800, outputTokens: 240 },
    },
    ...fields,
  });
  emit(session, { type: "session.changed", session: { activity: null } });
}

async function reply(session, turnId, text) {
  const message = addItem(session, turnId, "assistant_message", {
    text: "",
    agentId: session.row.agentId,
    status: "in_progress",
    endedAt: null,
  });
  for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) {
    if (settled(session, turnId)) return;
    emit(session, {
      type: "item.text_appended",
      itemId: message.id,
      field: "text",
      text: chunk,
      at: now(),
    });
    await sleep(30);
  }
  changeItem(session, message, { status: "completed", endedAt: now() });
}

/** Park a request; resolves with its response (or null when withdrawn). */
function ask(session, turnId, request) {
  const full = {
    id: randomUUID(),
    sessionId: session.row.id,
    turnId,
    attemptId: null,
    itemId: null,
    status: "pending",
    answerable: true,
    blocking: true,
    description: null,
    questions: null,
    approval: null,
    elicitation: null,
    approvers: [],
    expiresAt: null,
    response: null,
    resolvedBy: null,
    reason: null,
    createdAt: now(),
    resolvedAt: null,
    ...request,
  };
  emit(session, { type: "request.changed", request: full });
  addItem(session, turnId, "request", { requestId: full.id });
  changeTurn(session, turnId, {
    status: "waiting",
    activity: "Waiting for you",
  });
  return new Promise((resolve) => session.waiters.set(full.id, resolve));
}

async function runTurn(session, turnId) {
  const text = session.prompts.get(turnId) ?? "";
  changeTurn(session, turnId, {
    status: "running",
    attemptCount: (session.turns.get(turnId)?.attemptCount ?? 0) + 1,
    activeAttemptId: randomUUID(),
    startedAt: now(),
    activity: "Working",
    activityAt: now(),
    error: null,
    retryAt: null,
  });
  await sleep(300);
  if (!session.row.title) {
    emit(session, {
      type: "session.changed",
      session: { title: text.slice(0, 40) || "Chat", icon: "sparkles:orange" },
    });
  }

  if (text.startsWith("fail")) {
    changeTurn(session, turnId, {
      status: "failed",
      activity: null,
      activeAttemptId: null,
      completedAt: now(),
      error: {
        message: "The model provider is unavailable right now.",
        kind: "unavailable",
      },
    });
    // Retry runs the same turn again, and the second attempt works.
    session.prompts.set(turnId, text.replace(/^fail\s*/, "") || "retry");
    return;
  }

  if (text.startsWith("question")) {
    const response = await ask(session, turnId, {
      kind: "question",
      title: "Question",
      origin: { kind: "tool", id: "ask_user", displayName: "Helper" },
      questions: [
        {
          question: "Which environment should I target?",
          header: "Environment",
          multiSelect: false,
          options: [
            { label: "Production", description: "The live deployment." },
            { label: "Staging", description: "The safe playground." },
          ],
        },
      ],
    });
    if (response === "steered") {
      // A reply while the question waited: the agent answers it and leaves
      // the question open beside the chat.
      changeTurn(session, turnId, { status: "running", activity: "Working" });
      await reply(
        session,
        turnId,
        "Good question. Staging is the safe playground; production is live. Pick one when you are ready.",
      );
      finish(session, turnId);
      return;
    }
    if (settled(session, turnId)) return;
    changeTurn(session, turnId, { status: "running", activity: "Working" });
    const answer = response?.answers?.[0];
    await reply(
      session,
      turnId,
      !answer || answer === QUESTIONS_DISMISSED_MESSAGE
        ? "No problem, I will pick a sensible default."
        : `Going with **${answer}**.`,
    );
    finish(session, turnId);
    return;
  }

  if (text.startsWith("ask")) {
    const call = addItem(session, turnId, "tool_call", {
      tool: "mcp__slack__post_message",
      server: "slack",
      description: null,
      input: { channel: "#general", text: "Summary: all good." },
      result: null,
      error: null,
      status: "in_progress",
      endedAt: null,
    });
    const response = await ask(session, turnId, {
      kind: "approval",
      title: "Post to Slack",
      description: "Post the summary to #general",
      origin: { kind: "mcp", id: "slack", displayName: "Helper" },
      approval: {
        action: "Use post_message on slack",
        tool: {
          server: "slack",
          name: "post_message",
          input: { channel: "#general", text: "Summary: all good." },
        },
      },
    });
    if (settled(session, turnId)) return;
    changeTurn(session, turnId, { status: "running", activity: "Working" });
    const allowed = response?.decision === "approved";
    changeItem(session, call, {
      status: allowed ? "completed" : "failed",
      endedAt: now(),
      result: allowed ? { ok: true } : null,
      error: allowed ? null : "Denied",
    });
    await sleep(200);
    await reply(
      session,
      turnId,
      allowed
        ? "Posted the summary to **#general**."
        : "Okay, I did not post anything.",
    );
    finish(session, turnId);
    return;
  }

  changeTurn(session, turnId, { activity: "Reading files..." });
  const command = addItem(session, turnId, "command", {
    command: "ls -la",
    description: null,
    output: "",
    exitCode: null,
    status: "in_progress",
    endedAt: null,
  });
  await sleep(600);
  if (settled(session, turnId)) return;
  changeItem(session, command, {
    output: "12 files",
    exitCode: 0,
    status: "completed",
    endedAt: now(),
  });
  changeTurn(session, turnId, { activity: "Editing files..." });
  addItem(session, turnId, "file_change", {
    path: "src/index.ts",
    change: "modified",
    previousPath: null,
  });
  await sleep(500);
  if (settled(session, turnId)) return;
  await reply(
    session,
    turnId,
    `You said: **${text}**\n\nHere's what I did:\n\n- Looked around the project\n- Edited \`src/index.ts\`\n\n\`\`\`ts\nexport const answer = 42;\n\`\`\``,
  );
  finish(session, turnId, {
    outcome: {
      changedFiles: [{ path: "src/index.ts", kind: "modified" }],
      usage: { inputTokens: 1800, outputTokens: 240 },
    },
  });
}

function interruptTurn(session, turnId, commandId) {
  const turn = session.turns.get(turnId);
  if (!turn || settled(session, turnId)) return;
  for (const item of session.items.values()) {
    if (item.turnId === turnId && item.status === "in_progress")
      changeItem(session, item, { status: "cancelled", endedAt: now() });
  }
  for (const request of session.requests.values()) {
    if (request.turnId === turnId && request.status === "pending") {
      emit(session, {
        type: "request.changed",
        request: {
          ...request,
          status: "cancelled",
          reason: "The turn stopped.",
        },
      });
      session.waiters.get(request.id)?.(null);
      session.waiters.delete(request.id);
    }
  }
  changeTurn(
    session,
    turnId,
    {
      status: "interrupted",
      activity: null,
      activeAttemptId: null,
      completedAt: now(),
    },
    commandId,
  );
}

/** Apply one command; the receipt's `result`, or throws a refusal. */
function command(session, body) {
  const id = body.commandId;
  switch (body.type) {
    case "send": {
      const text = body.text ?? "";
      const active = activeTurn(session);
      const blockingQuestion =
        active &&
        [...session.requests.values()].find(
          (request) =>
            request.turnId === active.id &&
            request.status === "pending" &&
            request.kind === "question" &&
            request.blocking,
        );
      if (blockingQuestion && body.dispatch !== "interrupt") {
        // ADR 0195: the reply steers into the waiting turn; the question
        // stays open and stops blocking.
        const item = addItem(
          session,
          active.id,
          "user_message",
          userMessage({
            text,
            attachments: body.attachments,
            dispatch: "steer",
            commandId: id,
          }),
          id,
        );
        emit(session, {
          type: "request.changed",
          request: { ...blockingQuestion, blocking: false },
        });
        session.waiters.get(blockingQuestion.id)?.("steered");
        session.waiters.delete(blockingQuestion.id);
        return { itemId: item.id, turnId: active.id };
      }
      return enqueue(session, {
        text,
        attachments: body.attachments,
        dispatch: body.dispatch ?? "queue",
        commandId: id,
      });
    }
    case "interrupt": {
      const active = body.turnId
        ? session.turns.get(body.turnId)
        : activeTurn(session);
      if (active) interruptTurn(session, active.id, id);
      return {};
    }
    case "retry": {
      const turn = session.turns.get(body.turnId);
      if (!turn || (turn.status !== "failed" && turn.status !== "interrupted"))
        throw new Error("Only a failed or interrupted turn can run again");
      changeTurn(session, turn.id, { status: "queued", error: null }, id);
      void drain(session);
      return { turnId: turn.id };
    }
    case "edit_queued": {
      const turn = session.turns.get(body.turnId);
      if (!turn || (turn.status !== "queued" && turn.status !== "held"))
        throw new Error("That message already started");
      if (body.text !== undefined) {
        const item = session.items.get(turn.inputItemId);
        if (item) changeItem(session, item, { text: body.text });
        session.prompts.set(turn.id, body.text.trim());
      }
      if (body.held !== undefined)
        changeTurn(
          session,
          turn.id,
          { status: body.held ? "held" : "queued" },
          id,
        );
      void drain(session);
      return { turnId: turn.id };
    }
    case "cancel_queued": {
      const turn = session.turns.get(body.turnId);
      if (!turn || (turn.status !== "queued" && turn.status !== "held"))
        throw new Error("That message already started");
      changeTurn(session, turn.id, { status: "cancelled" }, id);
      return { turnId: turn.id };
    }
    case "send_now": {
      const turn = session.turns.get(body.turnId);
      if (!turn || (turn.status !== "queued" && turn.status !== "held"))
        throw new Error("That message already started");
      changeTurn(
        session,
        turn.id,
        { status: "queued", priority: 1, dispatch: "interrupt" },
        id,
      );
      const active = activeTurn(session);
      if (active) interruptTurn(session, active.id, id);
      void drain(session);
      return { turnId: turn.id };
    }
    case "respond": {
      const request = session.requests.get(body.requestId);
      if (request?.status !== "pending")
        throw new Error("That request was already answered");
      const response = body.response;
      emit(
        session,
        {
          type: "request.changed",
          request: {
            ...request,
            status: "resolved",
            response,
            resolvedBy: "member",
            resolvedAt: now(),
          },
        },
        id,
      );
      const waiter = session.waiters.get(request.id);
      session.waiters.delete(request.id);
      if (waiter) waiter(response);
      else if (response.kind === "question") {
        // A non-blocking question's answer arrives as a message (ADR 0195).
        const answers = response.answers;
        enqueue(session, {
          text:
            answers[0] === QUESTIONS_DISMISSED_MESSAGE
              ? QUESTIONS_DISMISSED_MESSAGE
              : `Answered: ${answers.join("; ")}`,
          dispatch: "queue",
          commandId: id,
          metadata: {
            questionRequestId: request.id,
            question: { questions: request.questions, answers },
          },
        });
      }
      return { requestId: request.id };
    }
    case "rollback": {
      const target = session.turns.get(body.turnId);
      if (!target) throw new Error("No such turn");
      for (const turn of session.turns.values()) {
        if (turn.ordinal >= target.ordinal && turn.status !== "cancelled")
          changeTurn(session, turn.id, { status: "rolled_back" }, id);
      }
      return { turnId: target.id };
    }
    default:
      throw new Error(`Unknown command ${body.type}`);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** `GET …/events?after=N`: everything after N, then live, as SSE frames. */
function streamEvents(req, res, session, after) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...CORS,
  });
  const write = (message, id) =>
    res.write(
      `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(message)}\n\n`,
    );
  const backlog = session.log.filter((stored) => stored.sequence > after);
  if (backlog.length > 0)
    write({ type: "events", events: backlog }, backlog.at(-1).sequence);
  else write({ type: "heartbeat", sequence: session.sequence });
  session.listeners.add(write);
  const heartbeat = setInterval(
    () => write({ type: "heartbeat", sequence: session.sequence }),
    15_000,
  );
  req.on("close", () => {
    clearInterval(heartbeat);
    session.listeners.delete(write);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return json(res, 204, {});
  const origin = `http://127.0.0.1:${PORT}`;
  if (path === "/.well-known/oauth-protected-resource") {
    return json(res, 200, {
      resource: `${origin}/api`,
      authorization_servers: [origin],
    });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      authorization_endpoint: `${origin}/api/auth/mcp/authorize`,
      token_endpoint: `${origin}/api/auth/mcp/token`,
      registration_endpoint: `${origin}/api/auth/mcp/register`,
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (path === "/api/auth/mcp/register" && req.method === "POST") {
    return json(res, 201, { client_id: "fake-pwa-client" });
  }
  if (path === "/api/auth/mcp/authorize" && req.method === "GET") {
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "fake-code");
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: callback.toString() });
    return res.end();
  }
  if (path === "/api/auth/mcp/token" && req.method === "POST") {
    return json(res, 200, {
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
      expires_in: 3600,
      scope: "openid profile email offline_access",
    });
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "No token" });

  const environments = {
    defaultEnvironment: "company",
    items: [
      {
        name: "company",
        label: "Company server",
        allowed: true,
        available: true,
        compatible: true,
        preferred: true,
        reasons: [],
        workloads: ["agent", "workflow"],
      },
    ],
  };
  if (
    path === `/api/projects/${PROJECT.id}/agent-catalog` &&
    req.method === "GET"
  )
    return json(res, 200, {
      items: [
        {
          id: `project:${PROJECT.id}:helper`,
          name: "Helper",
          available: true,
          reason: null,
          environments,
        },
      ],
      defaultAgentId: `project:${PROJECT.id}:helper`,
      startingActions: [],
    });
  if (
    path === `/api/projects/${PROJECT.id}/environments` &&
    req.method === "GET"
  )
    return json(res, 200, environments);
  if (path === `/api/projects/${PROJECT.id}/workflows` && req.method === "GET")
    return json(res, 200, []);
  if (
    path === `/api/projects/${PROJECT.id}/workflow-enablements` &&
    req.method === "GET"
  )
    return json(res, 200, []);

  // GET /api/me
  if (path === "/api/me" && req.method === "GET") {
    return json(res, 200, {
      version: 1,
      identity: { externalUserId: "member", root: false },
      projects: [
        {
          projectId: PROJECT.id,
          builder: false,
          source: null,
          permissions: [],
          agents: ["helper"],
          workflows: [],
          apps: [],
          documents: [],
        },
      ],
      features: {
        publications: false,
        proposals: false,
        proposalsOpenPullRequests: false,
        mcp: false,
        agentSessions: true,
        storeUploadMaxBytes: 0,
      },
      agentProtocol: AGENT_PROTOCOL,
    });
  }

  if (path === "/api/projects" && req.method === "GET") {
    return json(res, 200, { items: [PROJECT], total: 1 });
  }
  if (path === `/api/projects/${PROJECT.id}` && req.method === "GET") {
    return json(res, 200, PROJECT);
  }

  if (
    path === `/api/projects/${PROJECT.id}/documents/content` &&
    req.method === "GET"
  ) {
    if (THEME && url.searchParams.get("path") === ".work/theme.json") {
      return json(res, 200, {
        path: ".work/theme.json",
        source: "program",
        contentType: "application/json",
        size: 1,
        version: 1,
        text: JSON.stringify({ preset: THEME, overrides: {} }),
      });
    }
    return json(res, 404, { error: "Not found" });
  }

  const sessionsBase = `/api/projects/${PROJECT.id}/agent/sessions`;
  if (path === sessionsBase && req.method === "GET") {
    const all = [...sessions.values()].reverse().map(rowOf);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return json(res, 200, {
      items: all.slice(offset, offset + limit),
      total: all.length,
    });
  }
  if (path === sessionsBase && req.method === "POST") {
    const body = await readBody(req);
    return json(res, 201, rowOf(newSession(body)));
  }

  const match = path.startsWith(`${sessionsBase}/`)
    ? path.slice(sessionsBase.length + 1).split("/")
    : null;
  if (match) {
    const session = sessions.get(match[0]);
    if (!session) return json(res, 404, { error: "No such session" });
    if (match.length === 1 && req.method === "GET") {
      return json(res, 200, {
        ...rowOf(session),
        snapshot: snapshotOf(session),
      });
    }
    if (match[1] === "events" && req.method === "GET") {
      return streamEvents(
        req,
        res,
        session,
        Number(url.searchParams.get("after") ?? 0),
      );
    }
    if (match[1] === "items" && req.method === "GET") {
      // The snapshot always carries the whole transcript here.
      return json(res, 200, { items: [], olderBefore: null });
    }
    if (match[1] === "commands" && req.method === "POST") {
      const body = await readBody(req);
      const seen = session.receipts.get(body.commandId);
      if (seen) return json(res, 200, seen);
      let receipt;
      try {
        const result = command(session, body);
        receipt = {
          commandId: body.commandId,
          status: "accepted",
          sequence: session.sequence,
          result,
          error: null,
        };
      } catch (error) {
        receipt = {
          commandId: body.commandId,
          status: "rejected",
          sequence: session.sequence,
          result: null,
          error: {
            code: "conflict",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      session.receipts.set(body.commandId, receipt);
      return json(res, 200, receipt);
    }
    if (match[1] === "watchers" && req.method === "GET") {
      return json(res, 200, { items: [] });
    }
    if (match[1] === "subsessions" && req.method === "GET") {
      return json(
        res,
        200,
        [...sessions.values()]
          .filter((child) => child.row.parentSessionId === session.row.id)
          .map((child) => ({
            delegationId: child.row.id,
            routeId: "fake",
            task: child.row.title ?? "Review",
            contextMode: "fresh",
            allowFurtherDelegation: false,
            status: activeTurn(child) ? "running" : "completed",
            session: rowOf(child),
          })),
      );
    }
  }

  return json(res, 404, { error: `No route: ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `work://connect?server=${encodeURIComponent(`http://127.0.0.1:${PORT}/api`)}&project=${PROJECT.id}&name=${encodeURIComponent(PROJECT.name)}`;
  console.log(`Fake Catamorphic server on http://127.0.0.1:${PORT}/api`);
  console.log(`Connect link:\n${link}`);
});
