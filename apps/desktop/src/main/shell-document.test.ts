import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  app: { isPackaged: true },
  handle:
    vi.fn<
      (scheme: string, handler: (request: Request) => Promise<Response>) => void
    >(),
  registerSchemesAsPrivileged: vi.fn(),
  createView: vi.fn(),
  loadFile: vi.fn<(file: string) => Promise<void>>(),
  loadURL: vi.fn<(url: string) => Promise<void>>(),
  executeJavaScript: vi.fn<(script: string) => Promise<unknown>>(),
  close: vi.fn(),
}));
vi.mock("electron", () => ({
  app: native.app,
  protocol: { registerSchemesAsPrivileged: native.registerSchemesAsPrivileged },
  session: { defaultSession: { protocol: { handle: native.handle } } },
  WebContentsView: class {
    constructor(options: unknown) {
      native.createView(options);
    }
    webContents = {
      loadFile: native.loadFile,
      loadURL: native.loadURL,
      executeJavaScript: native.executeJavaScript,
      close: native.close,
    };
  },
}));

import {
  isSameShellDocument,
  isShellDocument,
  migrateShellStorage,
  registerShellScheme,
  serveShellDocuments,
  shellAssetPath,
  shellDocumentUrl,
} from "./shell-document.js";

let directory: string;
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
  native.app.isPackaged = true;
  native.loadFile.mockResolvedValue();
  native.loadURL.mockResolvedValue();
  native.executeJavaScript.mockReset();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "work-shell-documents-"));
  root = path.join(directory, "renderer");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(root, "index.html"),
      "<!doctype html><title>Work</title>",
    ),
    fs.writeFile(
      path.join(root, "assets", "app.js"),
      "export const ready = true;",
    ),
    fs.writeFile(path.join(root, "assets", "app.css"), "body{color:black}"),
    fs.writeFile(path.join(root, "private.env"), "not an application asset"),
    fs.writeFile(path.join(directory, "outside.html"), "outside renderer"),
  ]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("trusted shell documents", () => {
  it("permits reloads and fragments of the registered document without changing its scope", () => {
    const expected = "work-internal://shell/index.html?window=one&project=two";
    expect(isSameShellDocument(expected, expected)).toBe(true);
    expect(isSameShellDocument(expected, `${expected}#settings`)).toBe(true);
    for (const candidate of [
      "work-internal://shell/index.html?window=other&project=two",
      "work-internal://shell/index.html?window=one&project=other",
      "work-internal://shell/voice.html?window=one&project=two",
      "work-internal://shell/index.html",
      "work-guest://shell/index.html?window=one&project=two",
      "https://example.com/",
      "not a URL",
    ])
      expect(isSameShellDocument(expected, candidate)).toBe(false);
    expect(
      isSameShellDocument("https://example.com/", "https://example.com/"),
    ).toBe(false);
  });

  it("registers secure standard schemes without granting CSP or service-worker bypasses", () => {
    registerShellScheme();
    expect(native.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "work-internal",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
      {
        scheme: "work-guest",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);
  });

  it("builds the packaged origin and encodes query values", () => {
    const url = new URL(
      shellDocumentUrl({ query: { project: "one & two", window: "saved" } }),
    );
    expect(url.protocol).toBe("work-internal:");
    expect(url.host).toBe("shell");
    expect(url.pathname).toBe("/index.html");
    expect(url.searchParams.get("project")).toBe("one & two");
    expect(shellDocumentUrl({ page: "voice.html" })).toBe(
      "work-internal://shell/voice.html",
    );
  });

  it.each([
    "work-internal://shell/index.html",
    "work-internal://shell/index.html?window=one#restored",
    "work-internal://shell/voice.html",
  ])("recognizes a native shell entry document: %s", (url) => {
    expect(isShellDocument(url)).toBe(true);
  });

  it.each([
    "file:///renderer/index.html",
    "https://shell/index.html",
    "work-guest://shell/index.html",
    "work-internal://shell.evil/index.html",
    "work-internal://shell:999/index.html",
    "work-internal://other/index.html",
    "work-internal://user:password@shell/index.html",
    "work-internal://shell/storage-migration.html",
    "work-internal://shell/assets/app.js",
    "work-internal://shell/index.html/extra",
    "not a URL",
  ])("refuses shell authority for %s", (url) => {
    expect(isShellDocument(url)).toBe(false);
  });

  it("allows only the configured development server when unpackaged", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://127.0.0.1:4321/");
    native.app.isPackaged = false;
    expect(shellDocumentUrl()).toBe("http://127.0.0.1:4321/");
    expect(isShellDocument("http://127.0.0.1:4321/")).toBe(true);
    expect(isShellDocument("http://127.0.0.1:4321/index.html")).toBe(true);
    expect(isShellDocument("http://127.0.0.1:4321/voice.html")).toBe(true);
    expect(isShellDocument("http://127.0.0.1:4322/index.html")).toBe(false);
    expect(
      isShellDocument("http://127.0.0.1:4321/storage-migration.html"),
    ).toBe(false);
    native.app.isPackaged = true;
    expect(shellDocumentUrl()).toBe("work-internal://shell/index.html");
    expect(isShellDocument("http://127.0.0.1:4321/index.html")).toBe(false);
  });
});

describe("shell asset protocol fence", () => {
  it("resolves bundled assets with query strings to canonical files", async () => {
    expect(
      await shellAssetPath({
        root,
        url: "work-internal://shell/assets/app.js?v=1#module",
      }),
    ).toBe(await fs.realpath(path.join(root, "assets", "app.js")));
  });

  it.each([
    "work-internal://shell/..%2foutside.html",
    "work-internal://shell/assets/%2e%2e%2f%2e%2e%2foutside.html",
    "work-internal://shell/%5c..%5coutside.html",
    "work-internal://shell/index.html%00.js",
    "work-internal://shell/%E0%A4%A",
    "work-internal://shell/private.env",
    "work-internal://shell/missing.html",
    "work-internal://shell/assets/",
    "work-internal://other/index.html",
    "work-internal://shell:80/index.html",
    "work-internal://user:password@shell/index.html",
    "file:///index.html",
    "https://shell/index.html",
  ])("refuses malformed, escaping or non-asset URLs: %s", async (url) => {
    expect(await shellAssetPath({ root, url })).toBeNull();
  });

  it("fences symlinks by realpath, including a sibling sharing the root prefix", async () => {
    const sibling = `${root}-private`;
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, "index.html"), "private sibling");
    await fs.symlink(
      path.join(directory, "outside.html"),
      path.join(root, "outside.html"),
    );
    await fs.symlink(sibling, path.join(root, "linked"));
    await fs.symlink(
      path.join(root, "assets", "app.js"),
      path.join(root, "inside.js"),
    );
    expect(
      await shellAssetPath({ root, url: "work-internal://shell/outside.html" }),
    ).toBeNull();
    expect(
      await shellAssetPath({
        root,
        url: "work-internal://shell/linked/index.html",
      }),
    ).toBeNull();
    expect(
      await shellAssetPath({ root, url: "work-internal://shell/inside.js" }),
    ).toBe(await fs.realpath(path.join(root, "assets", "app.js")));
  });

  it("serves GET and bodyless HEAD with a fixed MIME type and nosniff", async () => {
    serveShellDocuments({ root });
    const registration = native.handle.mock.calls[0];
    expect(registration?.[0]).toBe("work-internal");
    const handler = registration?.[1];
    if (!handler) throw new Error("Missing shell protocol handler");
    const get = await handler(
      new Request("work-internal://shell/assets/app.js"),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await get.text()).toBe("export const ready = true;");
    const head = await handler(
      new Request("work-internal://shell/index.html", { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await head.text()).toBe("");
    const missing = await handler(
      new Request("work-internal://shell/private.env"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects %s without touching a bundled asset",
    async (method) => {
      serveShellDocuments({ root });
      const handler = native.handle.mock.calls[0]?.[1];
      if (!handler) throw new Error("Missing shell protocol handler");
      const response = await handler(
        new Request("work-internal://shell/index.html", { method }),
      );
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("");
      expect(await fs.readFile(path.join(root, "index.html"), "utf8")).toBe(
        "<!doctype html><title>Work</title>",
      );
    },
  );
});

describe("legacy shell storage migration lifecycle", () => {
  it("reads the legacy file origin in a sandbox and closes its view after import", async () => {
    native.executeJavaScript.mockResolvedValueOnce(
      JSON.stringify({ "review-comment:new": "Unsent draft" }),
    );
    native.executeJavaScript.mockResolvedValueOnce(undefined);
    await migrateShellStorage({ root });
    expect(native.createView).toHaveBeenCalledWith({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    expect(native.loadFile).toHaveBeenCalledWith(
      path.join(root, "storage-migration.html"),
    );
    expect(native.loadURL).toHaveBeenCalledWith(
      "work-internal://shell/storage-migration.html",
    );
    expect(native.executeJavaScript.mock.calls[1]?.[0]).toContain(
      "__work_origin_migrated_v1",
    );
    expect(native.executeJavaScript.mock.calls[1]?.[0]).toContain(
      "localStorage.getItem(key) === null",
    );
    expect(native.close).toHaveBeenCalledOnce();
  });

  it.each([null, "[]", "null", "not json"])(
    "closes the migration view and fails without importing invalid data: %s",
    async (data) => {
      native.executeJavaScript.mockResolvedValueOnce(data);
      await expect(migrateShellStorage({ root })).rejects.toThrow();
      expect(native.loadURL).not.toHaveBeenCalled();
      expect(native.close).toHaveBeenCalledOnce();
    },
  );

  it("closes its view when reading the old document fails", async () => {
    native.loadFile.mockRejectedValueOnce(new Error("Legacy document failed"));
    await expect(migrateShellStorage({ root })).rejects.toThrow(
      "Legacy document failed",
    );
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("closes its view when the target origin fails to load", async () => {
    native.executeJavaScript.mockResolvedValueOnce("{}");
    native.loadURL.mockRejectedValueOnce(new Error("Internal document failed"));
    await expect(migrateShellStorage({ root })).rejects.toThrow(
      "Internal document failed",
    );
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("leaves development-server storage alone", async () => {
    native.app.isPackaged = false;
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://127.0.0.1:4321/");
    await migrateShellStorage({ root });
    expect(native.createView).not.toHaveBeenCalled();
  });
});
