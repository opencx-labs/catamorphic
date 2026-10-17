// A real ACP agent process for the adapter's tests: the official SDK's
// agent side over stdio, with sessions kept in a JSON file (as Hermes keeps
// them in its own database) so a later process reopens them. It answers
// `Echo: <words>` and follows directives in the person's words:
//
//   [[tool <server> <name> <json>]]  call a tool on an MCP server it was given
//   [[permission]]                   ask permission, say the chosen option
//   [[hang]]                         work until cancelled
//   [[recall]]                       say how many turns the session has seen
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
          loadSession: true,
          promptCapabilities: { image: true },
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
      loadSession: async ({ sessionId, cwd, mcpServers }) => {
        const state = read();
        const session = state.sessions[sessionId];
        if (!session) throw acp.RequestError.resourceNotFound(sessionId);
        Object.assign(session, { cwd, mcpServers });
        write(state);
        // ACP replays the history before answering.
        for (const prompt of session.prompts) {
          await say(sessionId, "user_message_chunk", prompt.at(-1)?.text ?? "");
          await say(sessionId, "agent_message_chunk", "(replayed)");
        }
        return {};
      },
      cancel: async () => cancel(),
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
          await say(sessionId, "agent_message_chunk", `Tool said: ${text}`);
          return { stopReason: "end_turn" };
        }
        if (words.includes("[[permission]]")) {
          const { outcome } = await connection.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: "call-2",
              title: "rm -rf build",
              kind: "execute",
              rawInput: { command: "rm -rf build" },
            },
            options: [
              {
                optionId: "allow_once",
                kind: "allow_once",
                name: "Allow once",
              },
              {
                optionId: "allow_session",
                kind: "allow_always",
                name: "Allow for session",
              },
              { optionId: "deny", kind: "reject_once", name: "Deny" },
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
