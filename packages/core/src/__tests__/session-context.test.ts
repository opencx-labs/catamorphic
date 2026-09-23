import { describe, expect, it } from "vitest";
import { formatSessionContext } from "../services/agent-capabilities-service.js";

const snapshot = {
  observedAt: "2026-09-23T09:00:00.000Z",
  currentUser: {
    id: "u-1",
    displayName: "Rana",
    timeZone: "Asia/Amman",
    access: "member" as const,
    roles: [
      {
        name: "CSM",
        description: "Customer success managers.\n  Not technical.",
      },
      { name: "Reviewer" },
    ],
  },
  project: { id: "p", name: "Acme brain" },
  sessionId: "s",
  allocationId: "a",
  environment: "local",
  agentLoopHost: null,
  execution: {
    bindingId: "local",
    workerNodeId: null,
    commandTarget: "host_checkout" as const,
    workingDirectory: "/Users/rana/Work/acme",
    isolation: "process" as const,
    declaredCapabilities: [],
    harnessSandbox: "provider_configured" as const,
    workspaceLifetime: "session_managed" as const,
  },
};

describe("formatSessionContext (ADR 0152)", () => {
  it("names the person and describes their roles in plain words", () => {
    const text = formatSessionContext(snapshot);
    expect(text).toContain("Person: Rana (time zone Asia/Amman)");
    expect(text).toContain("Access: what their roles allow.");
    expect(text).toContain("- CSM: Customer success managers. Not technical.");
    expect(text).toContain("- Reviewer");
    expect(text).toContain("Project: Acme brain");
    expect(text).toContain(
      "run directly in the project folder at /Users/rana/Work/acme",
    );
    expect(text).not.toMatch(/allocation|bindingId|u-1/i);
  });

  it("says when commands run in a sandbox and when access is full", () => {
    const text = formatSessionContext({
      ...snapshot,
      currentUser: {
        id: "desktop-user",
        access: "full",
        roles: [],
      },
      execution: {
        ...snapshot.execution,
        commandTarget: "environment_sandbox",
        workingDirectory: "/workspace",
      },
    });
    expect(text).toContain("Person: desktop-user");
    expect(text).toContain("Access: full access to this project.");
    expect(text).not.toContain("Role");
    expect(text).toContain("isolated sandbox copy");
  });
});
