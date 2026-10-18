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
//   [[recall]]                       say how many turns the session has seen
//
// With TEST_AGENT_NO_LOAD=1 it cannot reopen a session, as ACP allows; with
// TEST_AGENT_RESUME=1 it also offers `session/resume`, which replays
// nothing. TEST_AGENT_EXIT_SAVE_MS=<ms> saves its state that long after its
// input closes, as Hermes saves its session on the way out. With
// TEST_AGENT_STUBBORN=1 it ignores a cancel and SIGTERM alike. It notes a
// cancel it heard as `cancelled` in its state.
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
          sessionCapabilities:
            process.env.TEST_AGENT_RESUME === "1" ? { resume: {} } : {},
        },
      }),
      authenticate: async () => {},
      newSession: async ({ cwd, mcpServers }) => {
        const state = read();
        const sessionId = `session-${Object.keys(state.sessions).length + 1}`;
        state.sessions[sessionId] = { cwd, mcpServers, prompts: [] };
        write(state);
        return { sessionId };
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
        const state = read();
        const session = state.sessions[sessionId];
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
        if (words.includes("[[hang]]")) {
          await say(sessionId, "agent_message_chunk", "Working");
          await new Promise((resolve) => {
            cancel = resolve;
          });
          return { stopReason: "cancelled" };
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
