import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RemoteSessionMirror } from "./remote-mirror.js";

/**
 * The turn-settled mirror pusher against a fake remote: pushes the full
 * transcript to the mirror route, and permanently stops for a session
 * once the remote reports divergence (continued there).
 */

interface Captured {
  url: string;
  body: {
    authority: { hostId: string; revision: number };
    title: string | null;
    todos: Array<{ id: string }>;
    messages: Array<{ id: string }>;
  };
}

let server: http.Server;
let base: string;
const captured: Captured[] = [];
let respondDiverged = false;
let mailboxItems: Array<Record<string, unknown>> = [];
let mailboxAcknowledgements = 0;
const handoffCompletions: Array<{
  destinationHostId: string;
  authorityRevision: number;
}> = [];
let handoffCancellations = 0;
let durableEnqueues = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url?.includes("/agent/sessions?limit=1")
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [], total: 0 }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.endsWith("/agent/sessions/s1")
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          authorityHostId: "server:test-host",
          authorityRevision: 2,
          mirrorMessageCount: 1,
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.includes("session-mailboxes")
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: mailboxItems }));
      return;
    }
    if (request.url?.endsWith("/acknowledge")) {
      mailboxAcknowledgements += 1;
      mailboxItems = [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      if (request.method === "POST" && request.url?.endsWith("/resume")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            authorityHostId: "server:test-host",
            authorityRevision: 2,
            mirrorMessageCount: 1,
          }),
        );
        return;
      }
      captured.push({ url: request.url ?? "", body: JSON.parse(data) });
      response.writeHead(respondDiverged ? 409 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          respondDiverged
            ? { diverged: true }
            : { authorityRevision: 1, mirrorMessageCount: 1 },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "object" && address) {
    base = `http://127.0.0.1:${address.port}/api`;
  }
});

afterAll(() => {
  server.close();
});

const forkMarks: Array<{ sessionId: string; serverUrl: string }> = [];
const incognitoMarks: string[] = [];
const importedMailboxIds: string[] = [];

function mirror(
  overrides: {
    incognito?: boolean;
    agentId?: string;
    parentSessionId?: string;
    incognitoIds?: string[];
    durable?: boolean;
    authorityHostId?: string;
  } = {},
) {
  const incognitoIds = new Set(
    overrides.incognitoIds ?? (overrides.incognito ? ["s1"] : []),
  );
  const detail = {
    id: "s1",
    title: "Desk chat",
    icon: "zap:blue",
    provider: "ai-sdk",
    agentId: overrides.agentId ?? null,
    parentSessionId: overrides.parentSessionId ?? null,
    authorityHostId: overrides.authorityHostId ?? "desktop:test-host",
    authorityRevision: 1,
    mirrorMessageCount: overrides.authorityHostId ? 1 : 0,
    status: "active",
    running: false,
    pendingTurns: [],
    todos: [
      {
        id: "5f14412c-e594-4b56-bbf1-894bcd68014c",
        title: "Mirror progress",
        description: "Keep remote session progress in sync.",
        status: "in_progress",
      },
    ],
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hi",
        metadata: null,
        createdAt: new Date("2026-08-21T10:00:00Z"),
      },
    ],
  };
  let enqueued = false;
  let claimed = false;
  let acknowledged = false;
  let diverged = false;
  const sync = {
    enqueue: vi.fn(async () => {
      durableEnqueues += 1;
      enqueued = true;
    }),
    claimDue: vi.fn(async () => {
      if (!enqueued || claimed) return [];
      claimed = true;
      return [
        {
          id: "intent-1",
          projectId: "local-1",
          sessionId: "s1",
          destinationKey: `${base}|remote-1`,
          authorityRevision: 1,
          messageCount: 1,
          attemptCount: 1,
        },
      ];
    }),
    acknowledge: vi.fn(async () => {
      acknowledged = true;
    }),
    fail: vi.fn(async () => undefined),
    markDiverged: vi.fn(async () => {
      diverged = true;
    }),
    status: vi.fn(async () => ({
      state: diverged ? "diverged" : acknowledged ? "acknowledged" : "pending",
      desiredAuthorityRevision: 1,
      desiredMessageCount: 1,
      acknowledgedAuthorityRevision: acknowledged ? 1 : null,
      acknowledgedMessageCount: acknowledged ? 1 : null,
    })),
  };
  return new RemoteSessionMirror({
    hostId: "desktop:test-host",
    ...(overrides.durable
      ? {
          identity: {
            tenantId: "tenant-1",
            externalUserId: "person-1",
          },
          getSessionSync: () => sync as never,
        }
      : {}),
    profiles: { list: () => ({ profiles: [{ id: "prof-1" }] }) } as never,
    profileConfig: {
      forProfile: () => ({
        remoteProjects: {
          accessToken: async () => "member-token",
          get: (projectId: string) =>
            projectId === "local-1"
              ? {
                  connectionId: "connection-1",
                  serverUrl: base,
                  remoteProjectId: "remote-1",
                  remoteProjectName: "Brain",
                  lastSyncAt: null,
                  credentials: {
                    clientId: "client-1",
                    accessToken: "member-token",
                    refreshToken: "refresh-token",
                    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
                    tokenEndpoint: `${base}/auth/mcp/token`,
                    scope: "openid offline_access",
                  },
                }
              : null,
          list: () => ({
            "local-1": {
              connectionId: "connection-1",
              serverUrl: base,
              remoteProjectId: "remote-1",
              remoteProjectName: "Brain",
              lastSyncAt: null,
            },
          }),
        },
      }),
    } as never,
    isIncognito: (sessionId: string) => incognitoIds.has(sessionId),
    markIncognito: (sessionId: string) => {
      incognitoMarks.push(sessionId);
      incognitoIds.add(sessionId);
    },
    sessionDetail: async () => detail as never,
    listSessions: async () => [detail as never],
    markFork: async (_projectId, sessionId, fork) => {
      forkMarks.push({ sessionId, serverUrl: fork.serverUrl });
    },
    importMailbox: async (_projectId, item) => {
      importedMailboxIds.push(item.id);
    },
    beginHandoff: async () => detail as never,
    cancelHandoff: async () => {
      handoffCancellations += 1;
      return detail as never;
    },
    completeHandoff: async (
      _projectId,
      _sessionId,
      destinationHostId,
      authorityRevision,
    ) => {
      handoffCompletions.push({ destinationHostId, authorityRevision });
      return detail as never;
    },
  });
}

const waitForCapturedLength = (length: number) =>
  vi.waitFor(() => expect(captured).toHaveLength(length), { timeout: 5_000 });

describe("RemoteSessionMirror", () => {
  it("pushes the transcript to the link's mirror route", async () => {
    const pusher = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(1);
    expect(captured[0]?.url).toBe(
      "/api/projects/remote-1/agent/sessions/s1/mirror",
    );
    expect(captured[0]?.body.title).toBe("Desk chat");
    expect(captured[0]?.body.authority).toEqual({
      hostId: "desktop:test-host",
      revision: 1,
    });
    expect(captured[0]?.body.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("does nothing for projects without a remote link", async () => {
    const pusher = mirror();
    pusher.mirrorInBackground("unlinked", "s1");
    expect(captured).toHaveLength(1);
  });

  it("skips incognito sessions entirely (ADR 0062)", async () => {
    const pusher = mirror({ incognito: true });
    pusher.mirrorInBackground("local-1", "s1");
    expect(captured).toHaveLength(1);
  });

  it("never mirrors a fork of an incognito chat, and records the inherited flag", async () => {
    const pusher = mirror({
      parentSessionId: "parent-1",
      incognitoIds: ["parent-1"],
    });
    pusher.mirrorInBackground("local-1", "s1");
    await vi.waitFor(() => expect(incognitoMarks).toEqual(["s1"]));
    // The fork's own id was never marked (a missed renderer marking), but
    // the lineage check catches it before anything leaves the machine.
    expect(captured).toHaveLength(1);
    expect(incognitoMarks).toEqual(["s1"]);
  });

  it("carries the project-agent slug so the fork runs the same agent", async () => {
    const pusher = mirror({ agentId: "project:local-1:reviewer" });
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(2);
    const body = captured[1]?.body as { agentSlug?: string } | undefined;
    expect(body?.agentSlug).toBe("reviewer");
  });

  it("moves only after the durable transcript receipt and remote authority claim", async () => {
    respondDiverged = false;
    const pusher = mirror({ durable: true });
    await expect(pusher.eligibility("local-1", "s1")).resolves.toEqual({
      canMove: true,
      reason: null,
    });
    await expect(pusher.moveToServer("local-1", "s1")).resolves.toMatchObject({
      ok: true,
      remoteProjectId: "remote-1",
    });
    expect(forkMarks.at(-1)).toEqual({ sessionId: "s1", serverUrl: base });
  });

  it("finishes a handoff after restart when the server already claimed authority", async () => {
    respondDiverged = true;
    handoffCompletions.length = 0;
    handoffCancellations = 0;
    const pusher = mirror({ durable: true });

    await expect(pusher.moveToServer("local-1", "s1")).resolves.toMatchObject({
      ok: true,
      remoteProjectId: "remote-1",
    });
    expect(handoffCompletions).toContainEqual({
      destinationHostId: "server:test-host",
      authorityRevision: 2,
    });
    expect(handoffCancellations).toBe(0);
    respondDiverged = false;
  });

  it("never heartbeats a stale copy whose authority is remote", async () => {
    const before = durableEnqueues;
    const pusher = mirror({
      durable: true,
      authorityHostId: "server:test-host",
    });
    pusher.syncMirrorsInBackground();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(durableEnqueues).toBe(before);
  });

  it("stops pushing on divergence and stamps the local fork marker", async () => {
    respondDiverged = true;
    forkMarks.length = 0;
    const before = captured.length;
    const pusher = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(before + 1);
    await vi.waitFor(() =>
      expect(forkMarks).toEqual([{ sessionId: "s1", serverUrl: base }]),
    );
    // The fork now lives on the server: no further pushes for s1.
    pusher.mirrorInBackground("local-1", "s1");
    expect(captured).toHaveLength(before + 1);
  });

  it("imports and acknowledges messages addressed to this desktop host", async () => {
    mailboxItems = [
      {
        id: "mailbox-1",
        projectId: "remote-1",
        sessionId: "s1",
        sourceHostId: "server:test-host",
        destinationHostId: "desktop:test-host",
        authorityRevision: 1,
        messageId: "message-1",
        content: "PR checks passed",
        author: { kind: "watcher", watcherId: "watcher-1" },
        mode: "next_turn",
        idempotencyKey: "delivery-1",
        metadata: null,
        createdAt: new Date().toISOString(),
      },
    ];
    const pusher = mirror();
    pusher.syncMailboxesInBackground();
    await vi.waitFor(() => expect(importedMailboxIds).toContain("mailbox-1"));
    await vi.waitFor(() => expect(mailboxAcknowledgements).toBe(1));
  });
});
