/*
 * A zero-dep fake Catamorphic server for companion development and e2e:
 * the agent-session + permission routes with a scripted agent, speaking
 * the same wire shapes as @catamorphic/fastify-plugin. Any bearer token is
 * accepted; "root-token" resolves a root identity (all projects), anything
 * else a scoped member of the one seeded project.
 *
 *   node scripts/dev-server.mjs          # port 8788 (PORT= to change)
 *
 * The scripted agent reads the user's message:
 *   "ask …"      → parks a tool-permission ask, then finishes
 *   "question …" → settles awaiting_input with an AskUserQuestion
 *   "fail …"     → settles failed
 *   anything     → tool events + a markdown reply
 * Set THEME=midnight (or light/paper) to serve a committed project theme.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const THEME = process.env.THEME;

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Brain",
  storageType: "managed",
  remoteUrl: null,
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** sessionId -> session record (messages inline). */
const sessions = new Map();
/** permissionId -> { entry, resolve } */
const permissions = new Map();

const now = () => new Date().toISOString();

function newSession(body) {
  const id = randomUUID();
  const session = {
    id,
    projectId: PROJECT.id,
    externalUserId: "member",
    provider: "fake",
    providerSessionId: null,
    sandboxId: null,
    agentId: body.agentId ?? null,
    modelEffort: body.effort ?? null,
    title: null,
    icon: null,
    parentSessionId: null,
    status: "active",
    baseCommitSha: null,
    createdAt: now(),
    updatedAt: now(),
    messages: [],
  };
  sessions.set(id, session);
  return session;
}

function pushMessage(session, role, content, metadata) {
  const message = {
    id: randomUUID(),
    sessionId: session.id,
    role,
    content,
    commitSha: null,
    metadata: metadata ?? null,
    createdAt: now(),
  };
  session.messages.push(message);
  session.updatedAt = now();
  return message;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(session, text) {
  const assistant = pushMessage(session, "assistant", "Thinking...", {
    status: "in_progress",
    events: [],
  });
  const update = (content, metadata) => {
    assistant.content = content;
    assistant.metadata = { ...assistant.metadata, ...metadata };
    session.updatedAt = now();
  };
  await sleep(400);
  if (!session.title) {
    session.title = text.slice(0, 40) || "Chat";
    session.icon = "sparkles:orange";
  }

  if (text.startsWith("fail")) {
    update("", { status: "failed", errorKind: "unavailable" });
    return;
  }

  if (text.startsWith("question")) {
    update("", {
      status: "awaiting_input",
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
    return;
  }

  if (text.startsWith("ask")) {
    update("Waiting for permission...", {
      events: [
        { type: "tool_call", toolName: "slack/post_message", toolInput: {} },
      ],
    });
    const id = randomUUID();
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        permissions.delete(id);
        resolve({ decision: "deny" });
      }, 60_000);
      permissions.set(id, {
        entry: {
          id,
          sessionId: session.id,
          agentLabel: "Fake Agent",
          request: {
            sessionId: session.id,
            server: "slack",
            tool: "post_message",
            description: "Post the summary to #general",
            input: { channel: "#general", text: "Summary: all good." },
            annotations: { destructiveHint: false },
          },
          createdAt: now(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        resolve: (value) => {
          clearTimeout(timer);
          permissions.delete(id);
          resolve(value);
        },
      });
    });
    await sleep(300);
    update(
      decision.decision === "allow"
        ? "Posted the summary to **#general**."
        : "Okay — I didn't post anything.",
      { status: "completed" },
    );
    return;
  }

  update("Reading files...", {
    events: [{ type: "command", content: "ls -la", toolResult: "12 files" }],
  });
  await sleep(700);
  update("Working...", {
    events: [
      { type: "command", content: "ls -la", toolResult: "12 files" },
      { type: "file_edit", filePath: "src/index.ts" },
    ],
  });
  await sleep(700);
  update(
    `You said: **${text}**\n\nHere's what I did:\n\n- Looked around the project\n- Edited \`src/index.ts\`\n\n\`\`\`ts\nexport const answer = 42;\n\`\`\``,
    {
      status: "completed",
      changedFiles: [{ path: "src/index.ts" }],
    },
  );
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return json(res, 204, {});
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "No token" });
  const root = auth === "Bearer root-token";

  // GET /api/me
  if (path === "/api/me" && req.method === "GET") {
    return json(res, 200, {
      version: 1,
      identity: { externalUserId: root ? "root" : "member", root },
      projects: root
        ? []
        : [
            {
              projectId: PROJECT.id,
              builder: false,
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
    if (THEME && url.searchParams.get("path") === ".catamorphic/theme.json") {
      return json(res, 200, {
        path: ".catamorphic/theme.json",
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
    const items = [...sessions.values()].map(
      ({ messages: _messages, ...session }) => session,
    );
    return json(res, 200, { items, total: items.length });
  }
  if (path === sessionsBase && req.method === "POST") {
    const body = await readBody(req);
    const { messages: _messages, ...session } = newSession(body);
    return json(res, 201, session);
  }

  const match = path.startsWith(`${sessionsBase}/`)
    ? path.slice(sessionsBase.length + 1).split("/")
    : null;
  if (match) {
    const session = sessions.get(match[0]);
    if (!session) return json(res, 404, { error: "No such session" });
    if (match.length === 1 && req.method === "GET") {
      return json(res, 200, session);
    }
    if (match[1] === "messages" && req.method === "POST") {
      const body = await readBody(req);
      pushMessage(session, "user", body.message ?? "");
      await runTurn(session, (body.message ?? "").trim());
      return json(res, 200, { ok: true });
    }
    if (match[1] === "interrupt" && req.method === "POST") {
      const last = session.messages.at(-1);
      if (
        last?.role === "assistant" &&
        last.metadata?.status === "in_progress"
      ) {
        last.metadata = {
          ...last.metadata,
          status: "failed",
          interrupted: true,
        };
        last.content = "";
      }
      return json(res, 200, { ok: true });
    }
    if (match[1] === "retry" && req.method === "POST") {
      const last = session.messages.at(-1);
      const lastUser = [...session.messages]
        .reverse()
        .find((message) => message.role === "user");
      if (last?.role === "assistant" && last.metadata?.status === "failed") {
        session.messages.pop();
        await runTurn(
          session,
          (lastUser?.content ?? "retry").replace(/^fail\s*/, ""),
        );
      }
      return json(res, 200, { ok: true });
    }
    if (match[1] === "permissions" && req.method === "GET") {
      const list = [...permissions.values()]
        .map((value) => value.entry)
        .filter((entry) => entry.sessionId === session.id);
      return json(res, 200, { permissions: list });
    }
    if (match[1] === "permissions" && match[2] && req.method === "POST") {
      const body = await readBody(req);
      const entry = permissions.get(match[2]);
      if (!entry) return json(res, 404, { error: "No such ask" });
      entry.resolve(body);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: `No route: ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `catamorphic://connect?server=${encodeURIComponent(`http://127.0.0.1:${PORT}/api`)}&token=invite-token&project=${PROJECT.id}&name=${encodeURIComponent(PROJECT.name)}`;
  console.log(`Fake Catamorphic server on http://127.0.0.1:${PORT}/api`);
  console.log(`Connect link:\n${link}`);
});
