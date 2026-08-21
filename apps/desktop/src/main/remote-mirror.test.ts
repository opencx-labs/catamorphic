import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteSessionMirror } from "./remote-mirror.js";

/**
 * The turn-settled mirror pusher against a fake remote: pushes the full
 * transcript to the mirror route, and permanently stops for a session
 * once the remote reports divergence (continued there).
 */

interface Captured {
  url: string;
  body: { title: string | null; messages: Array<{ id: string }> };
}

let server: http.Server;
let base: string;
const captured: Captured[] = [];
let respondDiverged = false;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      captured.push({ url: request.url ?? "", body: JSON.parse(data) });
      response.writeHead(respondDiverged ? 409 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(respondDiverged ? { diverged: true } : { id: "x" }),
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

function mirror(overrides: { incognito?: boolean; agentId?: string } = {}) {
  const incognito = overrides.incognito ?? false;
  const detail = {
    id: "s1",
    title: "Desk chat",
    icon: "zap:blue",
    provider: "ai-sdk",
    agentId: overrides.agentId ?? null,
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
  return new RemoteSessionMirror({
    profiles: { list: () => ({ profiles: [{ id: "prof-1" }] }) } as never,
    profileConfig: {
      forProfile: () => ({
        remoteProjects: {
          get: (projectId: string) =>
            projectId === "local-1"
              ? {
                  serverUrl: base,
                  remoteProjectId: "remote-1",
                  remoteProjectName: "Brain",
                  token: "member-token",
                }
              : null,
        },
      }),
    } as never,
    isIncognito: () => incognito,
    sessionDetail: async () => detail as never,
    markFork: async (_projectId, sessionId, fork) => {
      forkMarks.push({ sessionId, serverUrl: fork.serverUrl });
    },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("RemoteSessionMirror", () => {
  it("pushes the transcript to the link's mirror route", async () => {
    const pusher = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "/api/projects/remote-1/agent/sessions/s1/mirror",
    );
    expect(captured[0]?.body.title).toBe("Desk chat");
    expect(captured[0]?.body.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("does nothing for projects without a remote link", async () => {
    const pusher = mirror();
    pusher.mirrorInBackground("unlinked", "s1");
    await flush();
    expect(captured).toHaveLength(1);
  });

  it("skips incognito sessions entirely (ADR 0062)", async () => {
    const pusher = mirror({ incognito: true });
    pusher.mirrorInBackground("local-1", "s1");
    await flush();
    expect(captured).toHaveLength(1);
  });

  it("carries the project-agent slug so the fork runs the same agent", async () => {
    const pusher = mirror({ agentId: "project:local-1:reviewer" });
    pusher.mirrorInBackground("local-1", "s1");
    await flush();
    expect(captured).toHaveLength(2);
    const body = captured[1]?.body as { agentSlug?: string } | undefined;
    expect(body?.agentSlug).toBe("reviewer");
  });

  it("stops pushing on divergence and stamps the local fork marker", async () => {
    respondDiverged = true;
    const pusher = mirror();
    pusher.mirrorInBackground("local-1", "s1");
    await flush();
    expect(captured).toHaveLength(3);
    expect(forkMarks).toEqual([{ sessionId: "s1", serverUrl: base }]);
    // The fork now lives on the server: no further pushes for s1.
    pusher.mirrorInBackground("local-1", "s1");
    await flush();
    expect(captured).toHaveLength(3);
  });
});
