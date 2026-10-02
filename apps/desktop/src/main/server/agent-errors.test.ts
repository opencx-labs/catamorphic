import { describe, expect, it } from "vitest";
import { classifyAgentError, friendlyTurnError } from "./agent-errors.js";

describe("classifyAgentError", () => {
  it("classifies CLI OAuth session failures as auth", () => {
    // The exact message the Claude Code SDK emits when the local account's
    // access token expired and the refresh failed (laptop slept, or a
    // sibling client rotated the refresh token).
    expect(
      classifyAgentError(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe("auth");
    expect(classifyAgentError("OAuth token revoked")).toBe("auth");
    expect(
      classifyAgentError("Your session has expired. Please run /login"),
    ).toBe("auth");
  });

  it("keeps the classic provider auth signatures", () => {
    expect(classifyAgentError("401 User not found.")).toBe("auth");
    expect(classifyAgentError("invalid x-api-key")).toBe("auth");
  });

  it("does not classify tool output or interrupts", () => {
    expect(
      classifyAgentError("Tool curl failed: 401 unauthorized from example.com"),
    ).toBeUndefined();
    expect(classifyAgentError("Interrupted.")).toBeUndefined();
  });

  it("leaves ordinary failures unclassified", () => {
    expect(classifyAgentError("The model refused to answer")).toBeUndefined();
  });
});

it("explains native writer ownership without classifying it for automatic retry", () => {
  const original =
    "thread 01a090c8-1302-70e3-8055-5a412ec59c75 already has an active writer";
  const owned = friendlyTurnError({
    error: { message: original },
    agentName: "Codex",
    providerLabel: "Codex",
  });
  expect(owned.message).toContain("Close it there, then retry here");
  expect(owned.message).not.toContain("01a090c8");
  expect(owned.kind).toBeUndefined();
  const tool = friendlyTurnError({
    error: { message: `Tool read failed: ${original}` },
    agentName: "Codex",
    providerLabel: "Codex",
  });
  expect(tool.message).toBe(`Tool read failed: ${original}`);
});

it("does not mistake an unsupported Codex model for an unrelated MCP sign-in failure", () => {
  const message =
    "MCP connection failed: Unauthorized\nThis model requires a newer version of Codex";
  expect(classifyAgentError(message)).toBeUndefined();
  const error = friendlyTurnError({
    error: { message, kind: "auth" },
    agentName: "Codex",
    providerLabel: "Codex",
  });
  expect(error.message).toContain("Choose another model");
  expect(error.kind).toBeUndefined();
});

it("rewrites a provider's raw auth failure into the reconnect path", () => {
  const error = friendlyTurnError({
    error: { message: "User not found." },
    agentName: "Fake Agent",
    providerLabel: "OpenRouter",
  });
  expect(error.kind).toBe("auth");
  expect(error.message).toContain('rejected the credentials of the "Fake Agent"');
});
