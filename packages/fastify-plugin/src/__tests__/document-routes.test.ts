import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentPathError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const entry = {
  path: "store/customers/acme/notes.md",
  source: "store",
  contentType: "text/markdown",
  size: 12,
  version: 3,
  writtenBy: "alice",
  writtenAt: "2026-08-18T00:00:00.000Z",
};

function appWithDocuments(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const record =
    (op: string, result: unknown) =>
    async (args: unknown): Promise<unknown> => {
      calls.push({ op, args });
      if (result instanceof Error) throw result;
      return result;
    };
  const app = createTestApp({
    core: {
      documents: {
        list: record("list", [entry]),
        read: record("read", { ...entry, text: "# Acme\nhello" }),
        readBytes: record("readBytes", {
          ...entry,
          bytes: new TextEncoder().encode("# Acme\nhello"),
        }),
        write: record("write", entry),
        delete: record("delete", { version: 4 }),
        history: record("history", [
          {
            version: 3,
            deleted: false,
            contentType: "text/markdown",
            size: 12,
            writtenBy: "alice",
            writtenAt: entry.writtenAt,
          },
        ]),
        search: record("search", [
          {
            path: entry.path,
            source: "store",
            lines: [{ line: 2, text: "hello" }],
          },
        ]),
        ...overrides,
      },
    } as never,
  });
  apps.push(app);
  return { app, calls };
}

describe("document routes (ADR 0055)", () => {
  it("lists, reads (json + raw), writes, deletes, histories, searches", async () => {
    const { app, calls } = appWithDocuments();
    const base = `/api/projects/${PROJECT_ID}/documents`;

    expect(
      (await app.inject({ method: "GET", url: `${base}?prefix=store` })).json(),
    ).toEqual([entry]);
    expect(calls.at(-1)).toMatchObject({
      op: "list",
      args: { prefix: "store" },
    });

    const read = await app.inject({
      method: "GET",
      url: `${base}/content?path=store/customers/acme/notes.md&version=2`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().text).toBe("# Acme\nhello");
    expect(calls.at(-1)).toMatchObject({ op: "read", args: { version: 2 } });

    const raw = await app.inject({
      method: "GET",
      url: `${base}/raw?path=store/customers/acme/notes.md`,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toContain("text/markdown");
    expect(raw.headers["x-catamorphic-document-version"]).toBe("3");
    expect(raw.headers["x-catamorphic-written-by"]).toBe("alice");
    expect(raw.body).toBe("# Acme\nhello");

    const write = await app.inject({
      method: "PUT",
      url: `${base}/content`,
      payload: { path: entry.path, text: "# Acme\nhello", ifVersion: 2 },
    });
    expect(write.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      op: "write",
      args: { path: entry.path, content: "# Acme\nhello", ifVersion: 2 },
    });

    const bytes = await app.inject({
      method: "PUT",
      url: `${base}/content`,
      payload: {
        path: "store/customers/acme/logo.png",
        base64: Buffer.from([1, 2, 3]).toString("base64"),
      },
    });
    expect(bytes.statusCode).toBe(200);
    const written = calls.at(-1)?.args as { content: Uint8Array };
    expect(Array.from(written.content)).toEqual([1, 2, 3]);

    // Exactly one of text/base64.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `${base}/content`,
          payload: { path: "store/x", text: "a", base64: "YQ==" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `${base}/content`,
          payload: { path: "store/x" },
        })
      ).statusCode,
    ).toBe(400);

    const del = await app.inject({
      method: "DELETE",
      url: `${base}/content?path=store/customers/acme/notes.md&ifVersion=3`,
    });
    expect(del.json()).toEqual({ version: 4 });

    const history = await app.inject({
      method: "GET",
      url: `${base}/history?path=store/customers/acme/notes.md`,
    });
    expect(history.json()[0]).toMatchObject({ version: 3 });

    const search = await app.inject({
      method: "GET",
      url: `${base}/search?q=hello&mode=text&prefix=store&limit=10`,
    });
    expect(search.json()[0]).toMatchObject({ path: entry.path });
    expect(calls.at(-1)).toMatchObject({
      op: "search",
      args: { query: "hello", mode: "text", prefix: "store", limit: 10 },
    });
  });

  it("maps document errors: 404 / 400 / 409 with the current version", async () => {
    const { app } = appWithDocuments({
      read: async () => {
        throw new DocumentNotFoundError("store/missing.md");
      },
      write: async () => {
        throw new DocumentConflictError("store/x.md", 5);
      },
      delete: async () => {
        throw new DocumentPathError(
          "Only paths under store/ can be deleted here",
        );
      },
    });
    const base = `/api/projects/${PROJECT_ID}/documents`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${base}/content?path=store/missing.md`,
        })
      ).statusCode,
    ).toBe(404);
    const conflict = await app.inject({
      method: "PUT",
      url: `${base}/content`,
      payload: { path: "store/x.md", text: "x", ifVersion: 4 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().currentVersion).toBe(5);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `${base}/content?path=docs/a.md`,
        })
      ).statusCode,
    ).toBe(400);
  });
});
