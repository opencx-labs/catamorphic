import { describe, expect, it } from "vitest";
import { workflowEnablementConsentDigest } from "../services/workflow-enablement-consent.js";

const base = {
  projectId: "project-1",
  workflowName: "watchInbox",
  deploymentArtifactDigest: "artifact-digest",
  commitSha: "a".repeat(40),
  remoteBranch: "main",
  environment: "local",
  owner: { type: "member" as const, externalUserId: "alice" },
  connections: [
    {
      alias: "mail",
      bindingId: "binding-1",
      connectionId: "connection-1",
      providerKind: "mcp",
      principalKind: "member" as const,
      capabilities: ["messages.search", "messages.read"],
    },
  ],
  capabilities: ["messages.search", "messages.read"],
};

describe("workflowEnablementConsentDigest", () => {
  it("is stable across unordered capability inputs", () => {
    const reordered = {
      ...base,
      capabilities: [...base.capabilities].reverse(),
      connections: [
        {
          ...base.connections[0]!,
          capabilities: [...base.connections[0]!.capabilities].reverse(),
        },
      ],
    };
    expect(workflowEnablementConsentDigest(reordered)).toBe(
      workflowEnablementConsentDigest(base),
    );
  });

  it("changes for a different exact connection or deployment", () => {
    expect(
      workflowEnablementConsentDigest({
        ...base,
        connections: [
          { ...base.connections[0]!, connectionId: "connection-2" },
        ],
      }),
    ).not.toBe(workflowEnablementConsentDigest(base));
    expect(
      workflowEnablementConsentDigest({
        ...base,
        deploymentArtifactDigest: "new-artifact",
      }),
    ).not.toBe(workflowEnablementConsentDigest(base));
  });
});
