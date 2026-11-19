import { describe, expect, it } from "vitest";
import {
  workflowEnablementAuthorityDigest,
  workflowEnablementConsentDigest,
} from "../services/workflow-enablement-consent.js";

const base = {
  projectId: "project-1",
  workflowName: "watchInbox",
  deploymentArtifactDigest: "artifact-digest",
  commitSha: "a".repeat(40),
  remoteBranch: "main",
  environment: "default",
  owner: { type: "member" as const, externalUserId: "alice" },
  connections: [
    {
      alias: "mail",
      connectionId: "connection-1",
      providerKind: "mcp",
      principalKind: "member" as const,
      capabilities: ["messages.search", "messages.read"],
    },
  ],
  capabilities: ["messages.search", "messages.read"],
  permissions: ["sessions:write"],
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

  it("changes when the declared permissions change (ADR 0158)", () => {
    expect(
      workflowEnablementConsentDigest({
        ...base,
        permissions: ["sessions:write", "runs:read"],
      }),
    ).not.toBe(workflowEnablementConsentDigest(base));
    expect(
      workflowEnablementConsentDigest({ ...base, permissions: [] }),
    ).not.toBe(workflowEnablementConsentDigest(base));
  });

  it("covers the declared store documents, leaving digests of workflows that declare none as they were (ADR 0335)", () => {
    const documents = [
      { path: "store/polling/", access: "write" as const },
      { path: "store/config.json", access: "read" as const },
    ];
    // Computed before documents existed: consent given then still holds.
    expect(workflowEnablementConsentDigest(base)).toBe(
      "5c8eb936eea8edf3bfe966ba1aa6a9bef03c434a57d17bf2be5f4718a7f12887",
    );
    expect(workflowEnablementConsentDigest({ ...base, documents: [] })).toBe(
      workflowEnablementConsentDigest(base),
    );
    const declared = workflowEnablementConsentDigest({ ...base, documents });
    expect(declared).not.toBe(workflowEnablementConsentDigest(base));
    expect(
      workflowEnablementConsentDigest({
        ...base,
        documents: [...documents].reverse(),
      }),
    ).toBe(declared);
    expect(
      workflowEnablementConsentDigest({
        ...base,
        documents: [{ ...documents[0]!, access: "read" }, documents[1]!],
      }),
    ).not.toBe(declared);
  });
});

describe("workflowEnablementAuthorityDigest", () => {
  const triggers = [{ kind: "schedule", config: { cron: "* * * * *" } }];

  it("leaves store documents to following's coverage check (ADR 0335)", () => {
    const digest = workflowEnablementAuthorityDigest({
      ...base,
      triggers,
      secrets: [],
    });
    // Computed before documents existed.
    expect(digest).toBe(
      "77696ab6058415363347b9defd0ef9a383fd6ecc2ee0eb96f31a88e7808d6200",
    );
    expect(
      workflowEnablementAuthorityDigest({
        ...base,
        documents: [{ path: "store/polling/", access: "write" }],
        triggers,
        secrets: [],
      }),
    ).toBe(digest);
  });
});
