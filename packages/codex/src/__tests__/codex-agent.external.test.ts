import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAgent } from "../codex-agent.js";

const enabled =
  process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1" &&
  existsSync(join(homedir(), ".codex", "auth.json"));

describe.skipIf(!enabled)("CodexAgent local account integration", () => {
  it("returns ordinary text and completes without a fatal event", async () => {
    const agent = new CodexAgent();
    const session = await agent.startSession({
      projectId: "codex-external-smoke",
      userId: "local-user",
      sandboxId: "",
      sessionId: `codex-smoke-${Date.now()}`,
      workingDirectory: process.cwd(),
    });
    const events = [];
    for await (const event of agent.sendMessage(
      session,
      "Reply with exactly CATAMORPHIC_CODEX_SMOKE_OK. Do not use tools.",
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.content)
        .join(""),
    ).toContain("CATAMORPHIC_CODEX_SMOKE_OK");
    expect(events.at(-1)).toEqual({ type: "done" });
  }, 120_000);
});
