import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../index.js";
import {
  type ClaudeScenario,
  eventsOf,
  FIXTURE_MCP_SERVER,
  itemsOf,
  runScenario,
  type ScriptedRequest,
  scenarioAttempt,
  startScriptedModel,
} from "../testing/index.js";

/** One ordinary name, one that holds `__` (a connection alias may). */
const SERVERS = ["fixture", "fix__ture"] as const;

const lastMessage = (request: ScriptedRequest) =>
  JSON.stringify(
    (Array.isArray(request.body.messages) ? request.body.messages : []).at(
      -1,
    ) ?? null,
  );

const lookup = (index: number) => ({
  blocks: [
    {
      type: "tool_use" as const,
      id: `toolu_unpoliced_${index}`,
      name: `mcp__${SERVERS[index]}__lookup`,
      input: { word: "alpha" },
    },
  ],
});

/**
 * A server with no tool policy is allowed whole, whatever its name: Claude
 * Code matches allow rules against the whole server name, so neither call
 * may reach canUseTool, which refuses tools it was not told about.
 */
const unpolicedServers: ClaudeScenario = {
  name: "mcp-unpoliced-servers",
  description: "Unpoliced MCP servers are allowed whole, `__` in a name too.",
  model: (request) => {
    const last = lastMessage(request);
    if (last.includes("Look up a word on each server")) return lookup(0);
    if (last.includes("toolu_unpoliced_0")) return lookup(1);
    if (last.includes("toolu_unpoliced_1"))
      return { blocks: [{ type: "text", text: "Looked it up twice." }] };
    return {
      error: {
        status: 400,
        type: "invalid_request_error",
        message: `Unexpected request ${request.index}: ${last.slice(0, 300)}`,
      },
    };
  },
  attempts: [
    {
      start: (context) =>
        scenarioAttempt({
          context,
          scenario: "mcp-unpoliced-servers",
          turn: 1,
          text: "Look up a word on each server",
          overrides: {
            mcpServers: Object.fromEntries(
              SERVERS.map((name) => [name, context.fixtureServer]),
            ),
          },
        }),
    },
  ],
  check: ([outcome]) => {
    const calls = itemsOf(outcome).filter(
      (entry) => entry.item.kind === "tool_call",
    );
    expect(calls.map((call) => [call.item.tool, call.status])).toEqual(
      SERVERS.map((name) => [`mcp__${name}__lookup`, "completed"]),
    );
    for (const call of calls)
      expect(call.item.result).toEqual({
        word: "alpha",
        meaning: "a fixture word",
      });
    expect(
      eventsOf(outcome, "request.opened").filter(
        (event) => event.request.kind === "approval",
      ),
    ).toHaveLength(0);
  },
};

it("the pinned CLI runs unpoliced servers by their whole names", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "claude-live-mcp-allow-")),
  );
  const directories = {
    here: {
      cwd: path.join(root, "work"),
      state: path.join(root, "state"),
      home: path.join(root, "home"),
    },
    elsewhere: {
      cwd: path.join(root, "work-elsewhere"),
      state: path.join(root, "state-elsewhere"),
      home: path.join(root, "home-elsewhere"),
    },
  };
  let cwd = directories.here.cwd;
  const model = await startScriptedModel({
    reply: (request) => unpolicedServers.model(request, { cwd }),
  });
  try {
    const outcomes = await runScenario({
      scenario: unpolicedServers,
      directories,
      modelUrl: model.url,
      fixtureServer: {
        transport: "stdio",
        command: "bun",
        args: [FIXTURE_MCP_SERVER],
      },
      onAttempt: (attempt) => {
        cwd = attempt.cwd;
      },
      runner: () =>
        new InProcessRunner({
          adapters: { "claude-code": createClaudeCodeAdapter() },
          version: "live",
        }),
      timeoutMs: 45_000,
    });
    unpolicedServers.check(outcomes);
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
