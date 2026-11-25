import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolAnswerMs } from "../services/agent-sessions-service.js";
import { subsessionTools } from "../services/sessions/subsession-tools.js";

/*
 * The subsession tools as an agent is served them (ADR 0351): one whose
 * grants name other agents only must name the agent it starts, and Work
 * holds a call no longer than the agent's own client waits for it.
 */

const operations = {
  spawn: async () => ({}),
  waitFor: async () => [],
  interrupt: async () => {},
};

function spawnInput(copies: boolean) {
  const spawn = subsessionTools(operations, { copies }).find(
    (tool) => tool.name === "spawn_subsession",
  );
  if (!spawn) throw new Error("No spawn tool");
  return z.object(
    z.record(z.string(), z.custom<z.ZodType>()).parse(spawn.parameters),
  );
}

describe("subsession tools", () => {
  it("lets an agent that may copy itself leave agent out", () => {
    expect(spawnInput(true).safeParse({ task: "Check the docs" }).success).toBe(
      true,
    );
    // The default: a host that builds the tools over its own operations.
    const [spawn] = subsessionTools(operations);
    expect(
      z
        .object(
          z.record(z.string(), z.custom<z.ZodType>()).parse(spawn?.parameters),
        )
        .safeParse({ task: "Check the docs" }).success,
    ).toBe(true);
  });

  it("requires agent of one whose grants name other agents only", () => {
    const input = spawnInput(false);
    expect(input.safeParse({ task: "Check the docs" }).success).toBe(false);
    expect(
      input.safeParse({ task: "Check the docs", agent: "project:p:verifier" })
        .success,
    ).toBe(true);
    expect(JSON.stringify(z.toJSONSchema(input))).toContain(
      "you may not start a copy of yourself",
    );
  });

  it("holds a call a quarter less than the client waits, 15 seconds at most", () => {
    // An MCP client's 60 seconds leaves 45 for the wait.
    expect(toolAnswerMs(60_000)).toBe(45_000);
    expect(toolAnswerMs(20_000)).toBe(15_000);
    expect(toolAnswerMs(600_000)).toBe(585_000);
    expect(toolAnswerMs(0)).toBe(0);
  });
});
