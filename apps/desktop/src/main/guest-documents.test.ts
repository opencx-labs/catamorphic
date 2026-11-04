import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  handle:
    vi.fn<
      (scheme: string, handler: (request: Request) => Promise<Response>) => void
    >(),
}));
vi.mock("electron", () => ({
  session: { defaultSession: { protocol: { handle: native.handle } } },
}));
vi.mock("./mcp-apps.js", () => ({
  mcpAppViewCsp: vi.fn(),
  mcpAppViewDocument: vi.fn(),
}));

import { GuestDocuments, mcpAppViewUrl } from "./guest-documents.js";
import { DESKTOP_API_TOKEN_HEADER } from "./server/local-api-guard.js";

const API = "http://127.0.0.1:45001";
const SOURCE = `${API}/api/projects/project-one/apps/notes/guest`;
const TOKEN = "synthetic-test-only-token";
function fixture(input: { projectRoot?: string } = {}) {
  const state: { api: { url: string; apiToken: string } | undefined } = {
    api: { url: API, apiToken: TOKEN },
  };
  const allowed = new Set(["1:project-one", "2:project-two"]);
  const permits = vi.fn((ownerId: number, projectId: string) =>
    allowed.has(`${ownerId}:${projectId}`),
  );
  const documents = new GuestDocuments({
    api: () => state.api,
    views: () => undefined,
    permits,
    projectRoot: () => input.projectRoot,
  });
  documents.serve();
  const handler = native.handle.mock.calls.at(-1)?.[1];
  if (!handler) throw new Error("Missing guest protocol handler");
  const fetchDocument = (url: string, method = "GET") =>
    handler(new Request(url, { method }));
  return { state, allowed, permits, documents, fetchDocument };
}

const upstream = vi.fn<typeof fetch>();
const temporaryDirectories = new Set<string>();
beforeEach(() => {
  vi.clearAllMocks();
  upstream.mockReset();
  upstream.mockImplementation(
    async () =>
      new Response("<!doctype html><title>Notes</title>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'",
        },
      }),
  );
  vi.stubGlobal("fetch", upstream);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

async function pdfFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "work-pdf-grant-"));
  temporaryDirectories.add(directory);
  const root = path.join(directory, "project");
  const file = path.join(root, "notes.pdf");
  const outside = path.join(directory, "outside.pdf");
  await fs.mkdir(root);
  await Promise.all([
    fs.writeFile(file, "%PDF-1.7\nproject document"),
    fs.writeFile(outside, "%PDF-1.7\nprivate outside document"),
    fs.writeFile(path.join(root, "notes.txt"), "not a PDF"),
  ]);
  return { ...fixture({ projectRoot: root }), root, file, outside };
}

describe("project guest document grants", () => {
  it("issues an opaque document-only URL pinned to a permitted owner and project", async () => {
    const { documents, fetchDocument } = fixture();
    const url = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: SOURCE,
    });
    expect(url).toMatch(/^work-guest:\/\/p-[a-f0-9-]+\/document$/);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("project-one");
    expect(
      documents.projectUrl({ mountId: "test-mount", ownerId: 1, url: SOURCE }),
    ).toBe(url);
    const response = await fetchDocument(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Notes</title>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get(DESKTOP_API_TOKEN_HEADER)).toBeNull();
    const call = upstream.mock.calls[0];
    expect(call?.[0]?.toString()).toBe(SOURCE);
    expect(call?.[1]?.headers).toEqual({ [DESKTOP_API_TOKEN_HEADER]: TOKEN });
    expect(call?.[1]?.redirect).toBe("manual");
  });

  it("supports only an exactly matching remote-project guest endpoint", async () => {
    const { documents, fetchDocument } = fixture();
    const remote = `${API}/desktop/projects/project-one/remote-api/api/projects/project-one/apps/notes/guest`;
    const url = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: remote,
    });
    expect((await fetchDocument(url)).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]?.toString()).toBe(remote);
    expect(() =>
      documents.projectUrl({
        mountId: "test-mount",
        ownerId: 1,
        url: remote.replace(
          "remote-api/api/projects/project-one",
          "remote-api/api/projects/project-two",
        ),
      }),
    ).toThrow("not available");
  });

  it("gives concurrent mounts of one app separate document lifetimes", async () => {
    const { documents, fetchDocument } = fixture();
    const first = documents.projectUrl({
      ownerId: 1,
      mountId: "first-mount",
      url: SOURCE,
    });
    const second = documents.projectUrl({
      ownerId: 1,
      mountId: "second-mount",
      url: SOURCE,
    });
    expect(first).not.toBe(second);
    expect(
      documents.projectUrl({
        ownerId: 1,
        mountId: "second-mount",
        url: SOURCE,
      }),
    ).toBe(second);
    documents.close({ ownerId: 1, url: first });
    expect((await fetchDocument(first)).status).toBe(403);
    expect((await fetchDocument(second)).status).toBe(200);
  });

  it.each(["", "x".repeat(129)])(
    "rejects an invalid mount identity",
    (mountId) => {
      const { documents } = fixture();
      expect(() =>
        documents.projectUrl({ ownerId: 1, mountId, url: SOURCE }),
      ).toThrow("Invalid app mount");
    },
  );

  it.each([
    `${API}/api/projects`,
    `${API}/api/projects/project-one`,
    `${API}/api/projects/project-one/files/secrets`,
    `${API}/api/projects/project-one/apps/notes`,
    `${API}/api/projects/project-one/apps/notes/guest/extra`,
    `${API}/api/projects/project-one/apps/notes/presentation`,
    `${API}/api/projects/project-two/apps/notes/guest`,
    `${API}/api/projects/project-one/apps/notes/guest/../presentation`,
    "http://127.0.0.1:45002/api/projects/project-one/apps/notes/guest",
    "https://example.invalid/api/projects/project-one/apps/notes/guest",
    "http://user:password@127.0.0.1:45001/api/projects/project-one/apps/notes/guest",
    "file:///api/projects/project-one/apps/notes/guest",
    "work-internal://shell/index.html",
  ])(
    "rejects arbitrary APIs, cross-profile projects and foreign targets: %s",
    (url) => {
      const { documents } = fixture();
      expect(() =>
        documents.projectUrl({ mountId: "test-mount", ownerId: 1, url }),
      ).toThrow();
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("fails closed without a running server or an owner grant", () => {
    const { documents, state } = fixture();
    expect(() =>
      documents.projectUrl({ mountId: "test-mount", ownerId: 99, url: SOURCE }),
    ).toThrow("not available");
    state.api = undefined;
    expect(() =>
      documents.projectUrl({ mountId: "test-mount", ownerId: 1, url: SOURCE }),
    ).toThrow("unavailable");
  });

  it("does not turn another path on a granted origin into an API proxy", async () => {
    const { documents, fetchDocument } = fixture();
    const grant = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: SOURCE,
    });
    const origin = grant.slice(0, grant.lastIndexOf("/"));
    for (const suffix of [
      "/",
      "/api/projects",
      "/document/extra",
      "/%2e%2e%2fapi/projects",
    ]) {
      expect((await fetchDocument(`${origin}${suffix}`)).status).toBe(403);
    }
    expect(
      (await fetchDocument("work-guest://p-unknown/document")).status,
    ).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["HEAD", "POST", "PUT", "DELETE", "OPTIONS"])(
    "rejects guest %s requests",
    async (method) => {
      const { documents, fetchDocument } = fixture();
      const url = documents.projectUrl({
        mountId: "test-mount",
        ownerId: 1,
        url: SOURCE,
      });
      expect((await fetchDocument(url, method)).status).toBe(405);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("only forwards bounded theme data to the pinned source", async () => {
    const { documents, fetchDocument } = fixture();
    const url = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: `${SOURCE}?revision=saved`,
    });
    const request = new URL(url);
    request.searchParams.set("theme", JSON.stringify({ color: "#fff" }));
    request.searchParams.set("url", "https://example.invalid/steal");
    request.searchParams.set(DESKTOP_API_TOKEN_HEADER, "attacker-value");
    expect((await fetchDocument(request.href)).status).toBe(200);
    const forwarded = new URL(String(upstream.mock.calls[0]?.[0]));
    expect(forwarded.origin).toBe(API);
    expect(forwarded.pathname).toBe(new URL(SOURCE).pathname);
    expect(forwarded.searchParams.get("revision")).toBe("saved");
    expect(forwarded.searchParams.get("theme")).toBe(
      JSON.stringify({ color: "#fff" }),
    );
    expect(forwarded.searchParams.has("url")).toBe(false);
    request.searchParams.set("theme", "x".repeat(8193));
    expect((await fetchDocument(request.href)).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("lets only a grant's owner close it and revokes every document on owner teardown", async () => {
    const { documents, allowed, fetchDocument } = fixture();
    allowed.add("2:project-one");
    const first = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: SOURCE,
    });
    const second = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 2,
      url: SOURCE,
    });
    expect(second).not.toBe(first);
    documents.close({ ownerId: 2, url: first });
    expect((await fetchDocument(first)).status).toBe(200);
    documents.close({ ownerId: 1, url: first });
    expect((await fetchDocument(first)).status).toBe(403);
    documents.closeOwner(2);
    expect((await fetchDocument(second)).status).toBe(403);
  });

  it("rechecks profile ownership before fetching an already issued document", async () => {
    const { documents, allowed, fetchDocument } = fixture();
    const url = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: SOURCE,
    });
    allowed.delete("1:project-one");
    expect((await fetchDocument(url)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not send a replacement server's token to a grant from the previous API origin", async () => {
    const { documents, state, fetchDocument } = fixture();
    const url = documents.projectUrl({
      mountId: "test-mount",
      ownerId: 1,
      url: SOURCE,
    });
    state.api = {
      url: "http://127.0.0.1:45002",
      apiToken: "replacement-test-only-token",
    };
    expect((await fetchDocument(url)).status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["owner teardown", "profile change", "server replacement"])(
    "revokes an in-flight document on %s",
    async (change) => {
      const { documents, allowed, state, fetchDocument } = fixture();
      const url = documents.projectUrl({
        mountId: "test-mount",
        ownerId: 1,
        url: SOURCE,
      });
      const pending: { resolve?: (response: Response) => void } = {};
      upstream.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          pending.resolve = resolve;
        }),
      );
      const response = fetchDocument(url);
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
      if (change === "owner teardown") documents.closeOwner(1);
      else if (change === "profile change") allowed.delete("1:project-one");
      else state.api = { url: API, apiToken: "replacement-test-only-token" };
      if (!pending.resolve)
        throw new Error("The upstream response was not staged");
      pending.resolve(
        new Response("stale private document", {
          headers: { "content-type": "text/html" },
        }),
      );
      const result = await response;
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(await result.text()).not.toContain("stale private document");
    },
  );

  it.each([
    { status: 302, type: "text/html", expected: 302 },
    { status: 401, type: "text/html", expected: 401 },
    { status: 200, type: "application/json", expected: 502 },
  ])(
    "never follows redirects or exposes non-HTML API responses: $status $type",
    async ({ status, type, expected }) => {
      const { documents, fetchDocument } = fixture();
      upstream.mockResolvedValueOnce(
        new Response("private upstream payload", {
          status,
          headers: {
            "content-type": type,
            location: "https://example.invalid/redirect",
          },
        }),
      );
      const response = await fetchDocument(
        documents.projectUrl({
          mountId: "test-mount",
          ownerId: 1,
          url: SOURCE,
        }),
      );
      expect(response.status).toBe(expected);
      expect(await response.text()).toBe("");
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("uses a default-deny CSP when the upstream document has none", async () => {
    const { documents, fetchDocument } = fixture();
    upstream.mockResolvedValueOnce(
      new Response("<title>Notes</title>", {
        headers: { "content-type": "text/html" },
      }),
    );
    const response = await fetchDocument(
      documents.projectUrl({ mountId: "test-mount", ownerId: 1, url: SOURCE }),
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
  });

  it("fails closed on upstream errors and absent MCP mounts", async () => {
    const { documents, fetchDocument } = fixture();
    upstream.mockRejectedValueOnce(new Error("unavailable"));
    expect(
      (
        await fetchDocument(
          documents.projectUrl({
            mountId: "test-mount",
            ownerId: 1,
            url: SOURCE,
          }),
        )
      ).status,
    ).toBe(403);
    expect((await fetchDocument(mcpAppViewUrl("unknown/mount"))).status).toBe(
      404,
    );
    expect(mcpAppViewUrl("unknown/mount")).toBe(
      "work-guest://mcp/unknown%2Fmount",
    );
  });
});

describe("project PDF document grants", () => {
  it("serves only the granted PDF bytes with a fixed content type", async () => {
    const { documents, fetchDocument } = await pdfFixture();
    const url = await documents.pdfUrl({
      ownerId: 1,
      projectId: "project-one",
      filePath: "notes.pdf",
    });
    expect(url).toMatch(/^work-guest:\/\/pdf-[a-f0-9-]+\/document$/);
    const response = await fetchDocument(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("%PDF-1.7\nproject document");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects non-PDF files, parent traversal, absolute escapes and symlink escapes", async () => {
    const { documents, root, outside } = await pdfFixture();
    await fs.symlink(outside, path.join(root, "linked.pdf"));
    for (const filePath of [
      "notes.txt",
      "../outside.pdf",
      outside,
      "linked.pdf",
    ]) {
      await expect(
        documents.pdfUrl({ ownerId: 1, projectId: "project-one", filePath }),
      ).rejects.toThrow();
    }
    await expect(
      documents.pdfUrl({
        ownerId: 2,
        projectId: "project-one",
        filePath: "notes.pdf",
      }),
    ).rejects.toThrow("not available");
  });

  it("rechecks a granted file's realpath after it is replaced by a symlink", async () => {
    const { documents, file, outside, fetchDocument } = await pdfFixture();
    const url = await documents.pdfUrl({
      ownerId: 1,
      projectId: "project-one",
      filePath: "notes.pdf",
    });
    await fs.unlink(file);
    await fs.symlink(outside, file);
    const response = await fetchDocument(url);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("private outside document");
  });

  it("does not let a PDF grant browse sibling files or accept write requests", async () => {
    const { documents, fetchDocument } = await pdfFixture();
    const url = await documents.pdfUrl({
      ownerId: 1,
      projectId: "project-one",
      filePath: "notes.pdf",
    });
    expect(
      (await fetchDocument(url.replace("/document", "/notes.txt"))).status,
    ).toBe(403);
    expect((await fetchDocument(url, "POST")).status).toBe(405);
    expect((await fetchDocument(url, "HEAD")).status).toBe(405);
  });

  it("enforces live owner scope and revokes PDF grants on close and owner teardown", async () => {
    const { documents, allowed, fetchDocument } = await pdfFixture();
    const first = await documents.pdfUrl({
      ownerId: 1,
      projectId: "project-one",
      filePath: "notes.pdf",
    });
    documents.close({ ownerId: 2, url: first });
    expect((await fetchDocument(first)).status).toBe(200);
    allowed.delete("1:project-one");
    expect((await fetchDocument(first)).status).toBe(403);
    allowed.add("1:project-one");
    documents.close({ ownerId: 1, url: first });
    expect((await fetchDocument(first)).status).toBe(403);
    const second = await documents.pdfUrl({
      ownerId: 1,
      projectId: "project-one",
      filePath: "notes.pdf",
    });
    documents.closeOwner(1);
    expect((await fetchDocument(second)).status).toBe(403);
  });
});
