import http from "node:http";
import type {
  SessionSnapshot,
  StoredSessionEvent,
  Turn,
} from "@catamorphic/agent-protocol";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RemoteSessionMirror } from "./remote-mirror.js";

/**
 * The turn-settled mirror pusher against a fake remote (ADR 0197): pushes
 * a base snapshot to a remote without a copy, then only the log events
 * after the remote's sequence, follows `behind` answers, and permanently
 * stops for a session once the remote reports divergence (continued there).
 */

interface Captured {
  url: string;
  body: {
    authority: { hostId: string; revision: number };
    title: string | null;
    todos: Array<{ id: string }>;
    agentSlug?: string;
    base?: { sequence: number };
    events: Array<{ sequence: number }>;
  };
}

/** The fake remote's copy of s1: its sequence (null: no copy) and mode. */
const remote: {
  copySequence: number | null;
  mode: "accept" | "diverged" | "stuck";
} = { copySequence: null, mode: "accept" };

let server: http.Server;
let base: string;
const captured: Captured[] = [];
let mailboxItems: Array<Record<string, unknown>> = [];
let mailboxAcknowledgements = 0;

const send = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const remoteSessionView = (authorityHostId: string, revision: number) => ({
  authorityHostId,
  authorityRevision: revision,
  mirrorSequence: remote.copySequence ?? 0,
});

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url?.includes("/agent/sessions?limit=1")
    ) {
      send(response, 200, { items: [], total: 0 });
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.endsWith("/agent/sessions/s1")
    ) {
      send(response, 200, remoteSessionView("server:test-host", 2));
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.includes("session-mailboxes")
    ) {
      send(response, 200, { items: mailboxItems });
      return;
    }
    if (request.url?.endsWith("/acknowledge")) {
      mailboxAcknowledgements += 1;
      mailboxItems = [];
      send(response, 200, { ok: true });
      return;
    }
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      if (request.method === "POST" && request.url?.endsWith("/resume")) {
        send(response, 200, remoteSessionView("server:test-host", 2));
        return;
      }
      const body: Captured["body"] = JSON.parse(data);
      captured.push({ url: request.url ?? "", body });
      if (remote.mode === "diverged") {
        send(response, 409, { code: "diverged" });
        return;
      }
      if (remote.mode === "stuck") {
        send(response, 200, {
          session: remoteSessionView("desktop:test-host", 1),
          sequence: 0,
        });
        return;
      }
      if (body.base) remote.copySequence = body.base.sequence;
      if (remote.copySequence === null) {
        send(response, 409, { code: "behind", sequence: 0 });
        return;
      }
      const first = body.events[0];
      if (first && first.sequence !== remote.copySequence + 1) {
        send(response, 409, { code: "behind", sequence: remote.copySequence });
        return;
      }
      for (const event of body.events) remote.copySequence = event.sequence;
      send(response, 200, {
        session: remoteSessionView("desktop:test-host", 1),
        sequence: remote.copySequence,
      });
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

/** The local log of s1 has events 1..localSequence. */
let localSequence = 3;
const exportCalls: Array<number | null> = [];
const forkMarks: Array<{ sessionId: string; serverUrl: string }> = [];
const incognitoMarks: string[] = [];
const importedMailboxIds: string[] = [];
const handoffCompletions: Array<{
  destinationHostId: string;
  authorityRevision: number;
}> = [];
let handoffCancellations = 0;
let durableEnqueues = 0;

beforeEach(() => {
  remote.copySequence = null;
  remote.mode = "accept";
  localSequence = 3;
  captured.length = 0;
  exportCalls.length = 0;
  forkMarks.length = 0;
  handoffCompletions.length = 0;
  handoffCancellations = 0;
});

const NOW = "2026-10-02T10:00:00.000Z";

function snapshotAt(sequence: number, turns: Turn[] = []): SessionSnapshot {
  return {
    sequence,
    session: {
      id: "s1",
      projectId: "local-1",
      title: "Desk chat",
      icon: "zap:blue",
      agentId: null,
      model: null,
      modelEffort: null,
      status: "active",
      workStatus: "open",
      activity: null,
      todos: [],
      parentSessionId: null,
      forkedFromSessionId: null,
      attentionRevision: 0,
      environment: null,
      authorityHostId: "desktop:test-host",
      authorityRevision: 1,
      handoffStatus: "none",
      updatedAt: NOW,
    },
    turns,
    attempts: [],
    items: [],
    requests: [],
    providerThreads: [],
    olderBefore: null,
  };
}

function eventAt(sequence: number): StoredSessionEvent {
  return {
    sessionId: "s1",
    sequence,
    at: NOW,
    commandId: null,
    event: {
      type: "session.changed",
      session: { activity: `step ${sequence}` },
    },
  };
}

function queuedTurn(): Turn {
  return {
    id: "turn-1",
    sessionId: "s1",
    ordinal: 1,
    status: "queued",
    inputItemId: null,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 0,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
  };
}

function mirror(
  overrides: {
    incognito?: boolean;
    agentId?: string;
    parentSessionId?: string;
    incognitoIds?: string[];
    durable?: boolean;
    authorityHostId?: string;
    /** The durable receipt's watermark before this process pushed. */
    acknowledgedSequence?: number;
    turns?: Turn[];
  } = {},
) {
  const incognitoIds = new Set(
    overrides.incognitoIds ?? (overrides.incognito ? ["s1"] : []),
  );
  const detail = () => ({
    id: "s1",
    title: "Desk chat",
    icon: "zap:blue",
    source: "desktop",
    agentId: overrides.agentId ?? null,
    parentSessionId: overrides.parentSessionId ?? null,
    authorityHostId: overrides.authorityHostId ?? "desktop:test-host",
    authorityRevision: 1,
    mirrorSequence: 0,
    status: "active",
    workStatus: "open",
    running: false,
    todos: [
      {
        id: "5f14412c-e594-4b56-bbf1-894bcd68014c",
        title: "Mirror progress",
        description: "Keep remote session progress in sync.",
        status: "in_progress",
      },
    ],
    snapshot: snapshotAt(localSequence, overrides.turns),
  });
  let enqueued = false;
  let claimed = false;
  let acknowledged: number | null = null;
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
          sequence: localSequence,
          attemptCount: 1,
        },
      ];
    }),
    acknowledge: vi.fn(async (args: { sequence: number }) => {
      acknowledged = args.sequence;
    }),
    fail: vi.fn(async () => undefined),
    markDiverged: vi.fn(async () => {
      diverged = true;
    }),
    status: vi.fn(async () => ({
      state: diverged
        ? "diverged"
        : acknowledged !== null
          ? "acknowledged"
          : "pending",
      desiredAuthorityRevision: 1,
      desiredSequence: localSequence,
      acknowledgedAuthorityRevision: acknowledged !== null ? 1 : null,
      acknowledgedSequence:
        acknowledged ?? overrides.acknowledgedSequence ?? null,
    })),
  };
  const pusher = new RemoteSessionMirror({
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
    sessionDetail: async () => detail() as never,
    exportMirror: async ({ after }) => {
      exportCalls.push(after);
      if (after === null) {
        return { base: snapshotAt(localSequence), events: [] };
      }
      const events: StoredSessionEvent[] = [];
      for (let sequence = after + 1; sequence <= localSequence; sequence += 1) {
        events.push(eventAt(sequence));
      }
      return { events };
    },
    listSessions: async () => [detail() as never],
    markFork: async (_projectId, sessionId, fork) => {
      forkMarks.push({ sessionId, serverUrl: fork.serverUrl });
    },
    importMailbox: async (_projectId, item) => {
      importedMailboxIds.push(item.id);
    },
    beginHandoff: async () => detail() as never,
    cancelHandoff: async () => {
      handoffCancellations += 1;
      return detail() as never;
    },
    completeHandoff: async (
      _projectId,
      _sessionId,
      destinationHostId,
      authorityRevision,
    ) => {
      handoffCompletions.push({ destinationHostId, authorityRevision });
      return detail() as never;
    },
  });
  return { pusher, sync };
}

const waitForCapturedLength = (length: number) =>
  vi.waitFor(() => expect(captured).toHaveLength(length), { timeout: 5_000 });

/** Let a background push finish (its in-flight guard clears in `finally`). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("RemoteSessionMirror", () => {
  it("starts a remote copy with a base snapshot", async () => {
    const { pusher } = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(1);
    expect(exportCalls).toEqual([null]);
    expect(captured[0]?.url).toBe(
      "/api/projects/remote-1/agent/sessions/s1/mirror",
    );
    expect(captured[0]?.body.title).toBe("Desk chat");
    expect(captured[0]?.body.authority).toEqual({
      hostId: "desktop:test-host",
      revision: 1,
    });
    expect(captured[0]?.body.base?.sequence).toBe(3);
    expect(captured[0]?.body.events).toEqual([]);
    await vi.waitFor(() => expect(remote.copySequence).toBe(3));
  });

  it("then sends only the events after the remote's sequence", async () => {
    const { pusher } = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(1);
    await settle();
    localSequence = 5;
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(2);
    expect(exportCalls).toEqual([null, 3]);
    expect(captured[1]?.body.base).toBeUndefined();
    expect(captured[1]?.body.events.map((event) => event.sequence)).toEqual([
      4, 5,
    ]);
    await vi.waitFor(() => expect(remote.copySequence).toBe(5));
  });

  it("resends from the sequence a 409 behind names", async () => {
    // The durable receipt says 2, but the remote copy holds only event 1.
    remote.copySequence = 1;
    const { pusher, sync } = mirror({ durable: true, acknowledgedSequence: 2 });
    pusher.mirrorInBackground("local-1", "s1");
    await vi.waitFor(() => expect(sync.acknowledge).toHaveBeenCalled());
    expect(exportCalls).toEqual([2, 1]);
    expect(
      captured.map((push) => push.body.events.map((event) => event.sequence)),
    ).toEqual([[3], [2, 3]]);
    expect(remote.copySequence).toBe(3);
    expect(sync.acknowledge).toHaveBeenCalledWith({
      intentId: "intent-1",
      workerId: "desktop-session-sync:desktop:test-host",
      authorityRevision: 1,
      sequence: 3,
    });
  });

  it("sends a base when a 409 behind says the remote has nothing", async () => {
    const { pusher, sync } = mirror({ durable: true, acknowledgedSequence: 3 });
    pusher.mirrorInBackground("local-1", "s1");
    await vi.waitFor(() => expect(sync.acknowledge).toHaveBeenCalled());
    expect(exportCalls).toEqual([3, null]);
    expect(captured[0]?.body.base).toBeUndefined();
    expect(captured[1]?.body.base?.sequence).toBe(3);
    expect(remote.copySequence).toBe(3);
  });

  it("gives up when the remote never reaches the local sequence", async () => {
    remote.mode = "stuck";
    const { pusher, sync } = mirror({ durable: true });
    pusher.mirrorInBackground("local-1", "s1");
    await vi.waitFor(() => expect(sync.fail).toHaveBeenCalled());
    expect(captured).toHaveLength(5);
    expect(sync.acknowledge).not.toHaveBeenCalled();
  });

  it("does nothing for projects without a remote link", async () => {
    const { pusher } = mirror();
    pusher.mirrorInBackground("unlinked", "s1");
    await settle();
    expect(captured).toHaveLength(0);
  });

  it("skips incognito sessions entirely (ADR 0062)", async () => {
    const { pusher } = mirror({ incognito: true });
    pusher.mirrorInBackground("local-1", "s1");
    await settle();
    expect(captured).toHaveLength(0);
  });

  it("never mirrors a fork of an incognito chat, and records the inherited flag", async () => {
    const { pusher } = mirror({
      parentSessionId: "parent-1",
      incognitoIds: ["parent-1"],
    });
    pusher.mirrorInBackground("local-1", "s1");
    await vi.waitFor(() => expect(incognitoMarks).toEqual(["s1"]));
    // The fork's own id was never marked (a missed renderer marking), but
    // the lineage check catches it before anything leaves the machine.
    expect(captured).toHaveLength(0);
    expect(exportCalls).toHaveLength(0);
  });

  it("carries the project-agent slug so the fork runs the same agent", async () => {
    const { pusher } = mirror({ agentId: "project:local-1:reviewer" });
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(1);
    expect(captured[0]?.body.agentSlug).toBe("reviewer");
  });

  it("refuses to move a session with a queued turn", async () => {
    const { pusher } = mirror({ durable: true, turns: [queuedTurn()] });
    await expect(pusher.eligibility("local-1", "s1")).resolves.toEqual({
      canMove: false,
      reason: "Wait for the current work to finish",
    });
  });

  it("moves only after the durable receipt and remote authority claim", async () => {
    const { pusher } = mirror({ durable: true });
    await expect(pusher.eligibility("local-1", "s1")).resolves.toEqual({
      canMove: true,
      reason: null,
    });
    await expect(pusher.moveToServer("local-1", "s1")).resolves.toMatchObject({
      ok: true,
      remoteProjectId: "remote-1",
    });
    expect(captured[0]?.body.base?.sequence).toBe(3);
    expect(forkMarks.at(-1)).toEqual({ sessionId: "s1", serverUrl: base });
  });

  it("finishes a handoff after restart when the server already claimed authority", async () => {
    remote.mode = "diverged";
    remote.copySequence = 3;
    const { pusher } = mirror({ durable: true });

    await expect(pusher.moveToServer("local-1", "s1")).resolves.toMatchObject({
      ok: true,
      remoteProjectId: "remote-1",
    });
    expect(handoffCompletions).toContainEqual({
      destinationHostId: "server:test-host",
      authorityRevision: 2,
    });
    expect(handoffCancellations).toBe(0);
  });

  it("never heartbeats a stale copy whose authority is remote", async () => {
    const before = durableEnqueues;
    const { pusher } = mirror({
      durable: true,
      authorityHostId: "server:test-host",
    });
    pusher.syncMirrorsInBackground();
    await settle();
    expect(durableEnqueues).toBe(before);
  });

  it("stops pushing on divergence and stamps the local fork marker", async () => {
    remote.mode = "diverged";
    const { pusher } = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await waitForCapturedLength(1);
    await vi.waitFor(() =>
      expect(forkMarks).toEqual([{ sessionId: "s1", serverUrl: base }]),
    );
    await settle();
    // The fork now lives on the server: no further pushes for s1.
    pusher.mirrorInBackground("local-1", "s1");
    await settle();
    expect(captured).toHaveLength(1);
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
        mode: "queue",
        idempotencyKey: "delivery-1",
        metadata: null,
        createdAt: new Date().toISOString(),
      },
    ];
    const { pusher } = mirror();
    pusher.syncMailboxesInBackground();
    await vi.waitFor(() => expect(importedMailboxIds).toContain("mailbox-1"));
    await vi.waitFor(() => expect(mailboxAcknowledgements).toBe(1));
  });
});
