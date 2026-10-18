// A real ACP agent process for the adapter's tests: the official SDK's
// agent side over stdio, with sessions kept in a JSON file (as Hermes keeps
// them in its own database) so a later process reopens them. It answers
// `Echo: <words>` and follows directives in the person's words:
//
//   [[tool <server> <name> <json>]]  call a tool on an MCP server it was given
//   [[permission]]                   ask permission, say the chosen option
//   [[permission always-only]]       the same, offering no "allow once"
//   [[permission no-reject-once]]    the same, offering no "reject once"
//
//   [[hang]]                         work until cancelled
//   [[hang then ask]]                the same, then ask permission once cancelled
//   [[recall]]                       say how many turns the session has seen
//   [[model]]                        ask its model (a Chat Completions API) and
//                                    say what it answered
//   [[where]]                        say where its model is (WORK_MODEL_BASE_URL)
//
// With TEST_AGENT_NO_LOAD=1 it cannot reopen a session, as ACP allows; with
// TEST_AGENT_RESUME=1 it also offers `session/resume`, which replays
// nothing. TEST_AGENT_EXIT_SAVE_MS=<ms> saves its state that long after its
// input closes, as Hermes saves its session on the way out. With
// TEST_AGENT_LOAD picks how `session/load` fails: `hermes` answers nothing
// for a session it lost (no error, nothing replayed), as Hermes does, and
// `hermes-flaky` for any session, as Hermes does when restoring one fails;
// `plain` throws a plain error ("Invalid session identifier", as Gemini CLI
// does), `auth` asks for a sign-in, `busy` errs with a passing internal
// error, `opencode` answers a session it lacks with an internal error, as
// OpenCode does, and `crash` exits mid-load. TEST_AGENT_LIST=1 offers
// `session/list`. With
// TEST_AGENT_STUBBORN=1 it ignores a cancel and SIGTERM alike, and starts a
// process of its own (`sleeper` in its state). It notes a cancel it heard
// as `cancelled` in its state. With TEST_AGENT_PROVIDERS=1 it takes its
// providers from its client (ACP's `providers/set`): `main` (OpenAI API)
// and `cloud` (Bedrock), noted in its state as `providers`. With
// TEST_AGENT_MODELS=1 a session offers a model option, `default-model` or
// `deepseek/v4-flash`, and notes the one chosen as the session's `model`.
// Without a provider set, its model is at WORK_MODEL_BASE_URL with
// WORK_MODEL_API_KEY. TEST_AGENT_PROVIDERS=fail advertises providers and
// then fails to list them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Where sessions are kept: `TEST_AGENT_STATE`, else the first argument.
const stateFile = process.env.TEST_AGENT_STATE ?? process.argv[2];
const read = () =>
  fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
    : { sessions: {} };
const write = (state) =>
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

let cancel = () => {};

/** The model option a session offers with TEST_AGENT_MODELS=1. */
const modelOptions = (currentValue) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "default-model", name: "Default" },
      { value: "deepseek/v4-flash", name: "DeepSeek V4 Flash" },
    ],
  },
];
if (process.env.TEST_AGENT_STUBBORN === "1") process.on("SIGTERM", () => {});

const exitSave = Number(process.env.TEST_AGENT_EXIT_SAVE_MS ?? 0);
if (exitSave > 0)
  process.stdin.once("end", () =>
    setTimeout(() => {
      write({ ...read(), savedOnExit: true });
      process.exit(0);
    }, exitSave),
  );

new acp.AgentSideConnection(
  (connection) => {
    const say = (sessionId, sessionUpdate, text) =>
      connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate, content: { type: "text", text } },
      });
    return {
      initialize: async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "test-agent", version: "1" },
        agentCapabilities: {
          loadSession: process.env.TEST_AGENT_NO_LOAD !== "1",
          promptCapabilities: { image: true },
          sessionCapabilities: {
            ...(process.env.TEST_AGENT_RESUME === "1" ? { resume: {} } : {}),
            ...(process.env.TEST_AGENT_LIST === "1" ? { list: {} } : {}),
          },
          ...(process.env.TEST_AGENT_PROVIDERS ? { providers: {} } : {}),
        },
      }),
      unstable_listProviders: async () => {
        if (process.env.TEST_AGENT_PROVIDERS === "fail")
          throw acp.RequestError.methodNotFound("providers/list");
        return {
          providers: [
            { providerId: "main", supported: ["openai"], required: true },
            { providerId: "cloud", supported: ["bedrock"], required: false },
          ],
        };
      },
      unstable_disableProvider: async ({ providerId }) => {
        const state = read();
        state.disabled = [...(state.disabled ?? []), providerId];
        write(state);
        return {};
      },
      unstable_setProvider: async (provider) => {
        const state = read();
        state.providers = {
          ...state.providers,
          [provider.providerId]: provider,
        };
        write(state);
        return {};
      },
      setSessionConfigOption: async ({ sessionId, value }) => {
        const state = read();
        state.sessions[sessionId].model = value;
        write(state);
        return { configOptions: modelOptions(value) };
      },
      authenticate: async () => {},
      newSession: async ({ cwd, mcpServers }) => {
        const state = read();
        const sessionId = `session-${Object.keys(state.sessions).length + 1}`;
        state.sessions[sessionId] = { cwd, mcpServers, prompts: [] };
        write(state);
        return {
          sessionId,
          ...(process.env.TEST_AGENT_MODELS === "1"
            ? { configOptions: modelOptions("default-model") }
            : {}),
        };
      },
      resumeSession: async ({ sessionId, cwd, mcpServers }) => {
        const state = read();
        const session = state.sessions[sessionId];
        if (!session) throw acp.RequestError.resourceNotFound(sessionId);
        Object.assign(session, { cwd, mcpServers, reopenedWith: "resume" });
        write(state);
        return {};
      },
      loadSession: async ({ sessionId, cwd, mcpServers }) => {
        const failing = process.env.TEST_AGENT_LOAD;
        if (failing === "crash") process.exit(3);
        if (failing === "auth") throw acp.RequestError.authRequired();
        if (failing === "busy")
          throw acp.RequestError.internalError(undefined, "database is locked");
        if (failing === "plain")
          throw new Error(`Invalid session identifier: ${sessionId}`);
        if (failing === "hermes-flaky") return null;
        const state = read();
        const session = state.sessions[sessionId];
        if (!session && failing === "opencode")
          throw acp.RequestError.internalError(
            { service: "session" },
            "OpenCode service failure",
          );
        if (!session && failing === "hermes") return null;
        if (!session) throw acp.RequestError.resourceNotFound(sessionId);
        Object.assign(session, { cwd, mcpServers, reopenedWith: "load" });
        write(state);
        // ACP replays the history before answering.
        for (const prompt of session.prompts) {
          await say(sessionId, "user_message_chunk", prompt.at(-1)?.text ?? "");
          await say(sessionId, "agent_message_chunk", "(replayed)");
        }
        return {};
      },
      listSessions: async () => ({
        sessions: Object.entries(read().sessions).map(
          ([sessionId, session]) => ({
            sessionId,
            cwd: session.cwd,
          }),
        ),
      }),
      cancel: async () => {
        write({ ...read(), cancelled: true });
        if (process.env.TEST_AGENT_STUBBORN !== "1") cancel();
      },
      prompt: async ({ sessionId, prompt }) => {
        const state = read();
        const session = state.sessions[sessionId];
        session.prompts.push(prompt);
        write(state);
        const words = prompt.at(-1)?.text ?? "";
        await say(sessionId, "agent_thought_chunk", "Thinking it over.");
        const tool = words.match(/\[\[tool (\S+) (\S+) (.*)\]\]/);
        if (tool) {
          const [, server, name, json] = tool;
          const spec = session.mcpServers.find(
            (entry) => entry.name === server,
          );
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              title: `Calling ${name}`,
              kind: "other",
              status: "in_progress",
              rawInput: JSON.parse(json),
            },
          });
          const client = new Client({ name: "test-agent", version: "1" });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(spec.url), {
              requestInit: {
                headers: Object.fromEntries(
                  spec.headers.map((header) => [header.name, header.value]),
                ),
              },
            }),
          );
          const result = await client.callTool({
            name,
            arguments: JSON.parse(json),
          });
          await client.close();
          const text = result.content.map((part) => part.text).join("");
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              status: result.isError ? "failed" : "completed",
              content: [{ type: "content", content: { type: "text", text } }],
            },
          });
          // Agents may still say something about a call they finished,
          // even in the middle of a reply.
          await say(sessionId, "agent_message_chunk", "Tool said: ");
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              title: "Called it",
            },
          });
          await say(sessionId, "agent_message_chunk", text);
          return { stopReason: "end_turn" };
        }
        if (words.includes("[[permission")) {
          const alwaysOnly = words.includes("[[permission always-only]]");
          const noRejectOnce = words.includes("[[permission no-reject-once]]");
          const { outcome } = await connection.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: "call-2",
              title: "rm -rf build",
              kind: "execute",
              rawInput: { command: "rm -rf build" },
            },
            options: [
              ...(alwaysOnly
                ? []
                : [
                    {
                      optionId: "allow_once",
                      kind: "allow_once",
                      name: "Allow once",
                    },
                  ]),
              {
                optionId: "allow_session",
                kind: "allow_always",
                name: "Allow for session",
              },
              noRejectOnce
                ? {
                    optionId: "deny_always",
                    kind: "reject_always",
                    name: "Always deny",
                  }
                : { optionId: "deny", kind: "reject_once", name: "Deny" },
            ],
          });
          await say(
            sessionId,
            "agent_message_chunk",
            `Permission: ${outcome.outcome === "selected" ? outcome.optionId : "cancelled"}`,
          );
          return { stopReason: "end_turn" };
        }
        if (words.includes("[[hang")) {
          if (process.env.TEST_AGENT_STUBBORN === "1") {
            const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
            write({ ...read(), sleeper: sleeper.pid });
          }
          await say(sessionId, "agent_message_chunk", "Working");
          await new Promise((resolve) => {
            cancel = resolve;
          });
          if (words.includes("[[hang then ask]]")) {
            // Asked after the cancel, as an agent mid-step might.
            const { outcome } = await connection.requestPermission({
              sessionId,
              toolCall: { toolCallId: "call-3", title: "one more thing" },
              options: [
                { optionId: "allow_once", kind: "allow_once", name: "Allow" },
              ],
            });
            write({ ...read(), askedAfterCancel: outcome.outcome });
          }
          return { stopReason: "cancelled" };
        }
        if (words.includes("[[model]]")) {
          const provider = read().providers?.main;
          const base = provider?.baseUrl ?? process.env.WORK_MODEL_BASE_URL;
          const headers = provider?.headers ?? {
            authorization: `Bearer ${process.env.WORK_MODEL_API_KEY}`,
          };
          const answer = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({
              model: session.model ?? process.env.WORK_MODEL ?? "unset",
              messages: [{ role: "user", content: words }],
            }),
          });
          const json = await answer.json();
          await say(
            sessionId,
            "agent_message_chunk",
            `Model said (${answer.status}): ${json.choices?.[0]?.message?.content ?? JSON.stringify(json)}`,
          );
          return { stopReason: "end_turn" };
        }
        if (words.includes("[[where]]")) {
          await say(
            sessionId,
            "agent_message_chunk",
            process.env.WORK_MODEL_BASE_URL ?? "nowhere",
          );
          return { stopReason: "end_turn" };
        }
        if (words.includes("[[recall]]")) {
          await say(
            sessionId,
            "agent_message_chunk",
            `Turn ${session.prompts.length}`,
          );
          return { stopReason: "end_turn" };
        }
        await say(sessionId, "agent_message_chunk", "Echo: ");
        await say(sessionId, "agent_message_chunk", words);
        return { stopReason: "end_turn" };
      },
    };
  },
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
