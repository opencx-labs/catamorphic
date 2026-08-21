import { describe, expect, it } from "vitest";
import { classifyAgentError } from "./agent-errors.js";

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
