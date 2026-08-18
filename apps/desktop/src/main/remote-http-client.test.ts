import { describe, expect, it } from "vitest";
import { httpDocumentsClient } from "./remote-sync.js";

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
      token: "t0k",
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
      token: "t",
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
});
