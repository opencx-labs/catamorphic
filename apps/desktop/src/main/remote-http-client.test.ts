import { describe, expect, it } from "vitest";
import {
  ensureRemoteProjectAccess,
  httpDocumentsClient,
  storeOnlyDocumentsClient,
} from "./remote-sync.js";

/** Pins the wire shape against the plugin's documents routes (ADR 0055). */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("httpDocumentsClient", () => {
  const base = "https://brain.acme.com/api";
  const projectId = "p-1";

  it("lists, reads raw with headers, writes base64 with ifVersion, deletes, histories — bearer everywhere", async () => {
    const seen: Array<{
      url: string;
      method: string;
      auth: string | undefined;
      body?: unknown;
    }> = [];
    const client = httpDocumentsClient({
      serverUrl: `${base}/`,
      accessToken: async () => "t0k",
      projectId,
      fetch: fakeFetch(async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url,
          method: init?.method ?? "GET",
          auth: headers.get("authorization") ?? undefined,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.endsWith("/documents"))
          return json(200, [
            {
              path: "docs/a.md",
              source: "program",
              contentType: "text/markdown",
              size: -1,
              digest: "git:x",
            },
          ]);
        if (url.includes("/documents/raw?")) {
          return new Response("hello", {
            status: 200,
            headers: {
              "content-type": "text/markdown",
              "x-catamorphic-document-source": "store",
              "x-catamorphic-document-version": "4",
            },
          });
        }
        if (url.includes("/documents/content") && init?.method === "PUT")
          return json(200, {
            path: "store/x.md",
            source: "store",
            contentType: "text/markdown",
            size: 5,
            version: 5,
          });
        if (url.includes("/documents/content") && init?.method === "DELETE")
          return json(200, { version: 6 });
        if (url.includes("/documents/history?"))
          return json(200, [
            {
              version: 5,
              deleted: false,
              contentType: "text/markdown",
              size: 5,
              writtenBy: "alice",
              writtenAt: "2026-08-18T00:00:00Z",
            },
          ]);
        return json(404, { error: "nope" });
      }),
    });

    expect((await client.list())[0]?.path).toBe("docs/a.md");
    const read = await client.readBytes("store/x.md", 4);
    expect(new TextDecoder().decode(read.bytes)).toBe("hello");
    expect(read.entry).toMatchObject({
      source: "store",
      version: 4,
      contentType: "text/markdown",
    });
    const write = await client.write({
      path: "store/x.md",
      bytes: new TextEncoder().encode("hello"),
      ifVersion: 4,
    });
    expect(write).toMatchObject({ ok: true, entry: { version: 5 } });
    expect(await client.delete({ path: "store/x.md", ifVersion: 5 })).toEqual({
      ok: true,
      version: 6,
    });
    expect((await client.history("store/x.md"))[0]?.version).toBe(5);

    expect(seen.map((s) => `${s.method} ${s.url.slice(base.length)}`)).toEqual([
      "GET /projects/p-1/documents",
      "GET /projects/p-1/documents/raw?path=store%2Fx.md&version=4",
      "PUT /projects/p-1/documents/content",
      "DELETE /projects/p-1/documents/content?path=store%2Fx.md&ifVersion=5",
      "GET /projects/p-1/documents/history?path=store%2Fx.md",
    ]);
    expect(seen.every((s) => s.auth === "Bearer t0k")).toBe(true);
    expect(seen[2]?.body).toEqual({
      path: "store/x.md",
      base64: Buffer.from("hello").toString("base64"),
      ifVersion: 4,
    });
  });

  it("maps 409 to a conflict with the current version, 404 delete to notFound, other failures to errors with the server's message", async () => {
    const client = httpDocumentsClient({
      serverUrl: base,
      accessToken: async () => "t",
      projectId,
      fetch: fakeFetch((_url, init) => {
        if (init?.method === "PUT")
          return json(409, { error: "stale", currentVersion: 9 });
        if (init?.method === "DELETE") return json(404, { error: "gone" });
        return json(403, { error: "Not authorized to perform that operation" });
      }),
    });
    expect(
      await client.write({
        path: "store/x.md",
        bytes: new Uint8Array(),
        ifVersion: 3,
      }),
    ).toEqual({ ok: false, conflict: true, currentVersion: 9 });
    expect(await client.delete({ path: "store/x.md" })).toEqual({
      ok: false,
      notFound: true,
    });
    await expect(client.list()).rejects.toThrow(
      /Listing documents failed \(403\): Not authorized/,
    );
  });

  it("uses the same authenticated client for roles, members, and invitations", async () => {
    const requests: Request[] = [];
    const client = httpDocumentsClient({
      serverUrl: base,
      accessToken: async () => "manager-token",
      projectId,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/roles")) {
          return Response.json([
            { slug: "member", definition: { name: "Member" } },
          ]);
        }
        if (request.url.endsWith("/admission/members")) {
          return Response.json([
            {
              externalUserId: "user-1",
              name: "Ada",
              email: "ada@example.com",
              roles: ["member"],
            },
          ]);
        }
        if (
          request.method === "GET" &&
          request.url.endsWith("/admission/requests")
        ) {
          return Response.json([
            {
              id: "request-1",
              externalUserId: "user-2",
              email: "grace@example.com",
              emailVerified: true,
              status: "pending",
              requestedAt: "2026-08-26T00:00:00.000Z",
            },
          ]);
        }
        if (request.method === "POST") {
          return Response.json({
            id: "invite-1",
            expiresAt: "2026-09-02T00:00:00.000Z",
            connectLinks: ["catamorphic://connect?project=p-1"],
            webLinks: [],
          });
        }
        return Response.json({ ok: true });
      },
    });

    expect((await client.listRoles())[0]?.slug).toBe("member");
    expect((await client.listMembers())[0]?.email).toBe("ada@example.com");
    expect((await client.listAccessRequests())[0]?.id).toBe("request-1");
    await client.setMemberRoles("user-1", ["manager"]);
    await client.decideAccessRequest("request-1", "approved");
    expect(
      await client.inviteMember({
        email: "grace@example.com",
        roles: ["member"],
      }),
    ).toMatchObject({ id: "invite-1" });
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") === "Bearer manager-token",
      ),
    ).toBe(true);
  });

  it("redeems an invitation through the authenticated admission surface", async () => {
    let request: Request | undefined;
    const client = httpDocumentsClient({
      serverUrl: base,
      accessToken: async () => "member-token",
      projectId,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ ok: true });
      },
    });

    await client.admit({ invitationId: "invite/1" });

    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      `${base}/projects/p-1/admission/invitations/invite%2F1/redeem`,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer member-token");
  });

  it("filters program files out of a builder checkout sync", async () => {
    const client = httpDocumentsClient({
      serverUrl: base,
      accessToken: async () => "builder-token",
      projectId,
      fetch: async () =>
        Response.json([
          {
            path: "src/index.ts",
            source: "program",
            contentType: "text/plain",
            size: 1,
            digest: "git:1",
          },
          {
            path: "store/notes.md",
            source: "store",
            contentType: "text/markdown",
            size: 1,
            version: 1,
          },
        ]),
    });

    const scoped = storeOnlyDocumentsClient(client);

    expect(scoped.sources).toEqual(["store"]);
    expect((await scoped.list()).map((entry) => entry.path)).toEqual([
      "store/notes.md",
    ]);
  });

  it("redeems admission before a first-time member reads project data", async () => {
    const paths: string[] = [];
    let admitted = false;
    const client = httpDocumentsClient({
      serverUrl: base,
      accessToken: async () => "new-member-token",
      projectId,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        paths.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.url.endsWith("/me")) {
          return Response.json({
            version: 1,
            identity: { externalUserId: "user-1", root: false },
            projects: admitted ? [{ projectId }] : [],
            features: {},
          });
        }
        admitted = true;
        return Response.json({ ok: true });
      },
    });

    await ensureRemoteProjectAccess({
      client,
      projectId,
      invitationId: "invite-1",
    });

    expect(paths).toEqual([
      "GET /api/me",
      "POST /api/projects/p-1/admission/invitations/invite-1/redeem",
      "GET /api/me",
    ]);
  });

  it("fails closed when the server cannot report remote capabilities", async () => {
    const client = httpDocumentsClient({
      serverUrl: base,
      accessToken: async () => "member-token",
      projectId,
      fetch: async () =>
        Response.json({ error: "Capabilities unavailable" }, { status: 503 }),
    });

    await expect(client.me()).rejects.toThrow(
      "Reading your access failed (503): Capabilities unavailable",
    );
  });
});
