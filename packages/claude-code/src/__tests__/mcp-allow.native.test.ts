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
 * may reach canUseTool, which refuses tools it was not told about. Each
 * call is reported on the server it ran on.
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
    expect(
      calls.map((call) => [call.item.tool, call.item.server, call.status]),
    ).toEqual(
      SERVERS.map((name) => [`mcp__${name}__lookup`, name, "completed"]),
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

/**
 * A policed server beside an unpoliced one whose name is its prefix: the
 * unpoliced `fix` is allowed as `mcp__fix__*`, which must not reach
 * `fix__ture`'s tools, so that call still asks.
 */
const policedBesidePrefix: ClaudeScenario = {
  name: "mcp-policed-beside-prefix",
  description:
    "A policed `fix__ture` asks although an unpoliced `fix` is allowed.",
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
          scenario: "mcp-policed-beside-prefix",
          turn: 1,
          text: "Look up a word on each server",
          overrides: {
            mcpServers: Object.fromEntries(
              SERVERS.map((name) => [name, context.fixtureServer]),
            ),
            toolPolicies: { fix__ture: [{ default: "ask" }] },
          },
        }),
      host: {
        answer: ({ request }) =>
          request.kind === "approval"
            ? { kind: "approval", decision: "approved" }
            : undefined,
      },
    },
  ],
  check: ([outcome]) => {
    const approvals = eventsOf(outcome, "request.opened").filter(
      (event) => event.request.kind === "approval",
    );
    expect(
      approvals.map((event) => event.request.approval?.tool?.server),
    ).toEqual(["fix__ture"]);
    const calls = itemsOf(outcome).filter(
      (entry) => entry.item.kind === "tool_call",
    );
    expect(calls.map((call) => [call.item.server, call.status])).toEqual(
      SERVERS.map((name) => [name, "completed"]),
    );
  },
};

async function runLive(scenario: ClaudeScenario) {
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
    reply: (request) => scenario.model(request, { cwd }),
  });
  try {
    const outcomes = await runScenario({
      scenario,
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
    scenario.check(outcomes);
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}

it(
  "the pinned CLI runs unpoliced servers by their whole names",
  () => runLive(unpolicedServers),
  60_000,
);

it(
  "the pinned CLI asks for a policed server whose name extends an allowed one",
  () => runLive(policedBesidePrefix),
  60_000,
);
