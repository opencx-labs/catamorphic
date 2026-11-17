import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type TranslationFile, TranslationFileStore } from "./models.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((step) => step()));
});

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A loopback server for files, counting requests. */
async function fixture(files: Record<string, Uint8Array>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "translation-models-"));
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const name = (request.url ?? "").slice(1);
    requests.push(name);
    const body = files[name];
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": body.byteLength });
    // Two chunks, so progress is seen between them.
    const half = Math.floor(body.byteLength / 2);
    response.write(body.subarray(0, half));
    setTimeout(() => response.end(body.subarray(half)), 10);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () => new Promise((resolve) => server.close(() => resolve())),
    () => fs.rm(root, { recursive: true, force: true }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    root,
    requests,
    store: new TranslationFileStore({
      rootDir: path.join(root, "models"),
      origin: `http://127.0.0.1:${port}`,
    }),
  };
}

function pinned(
  name: string,
  content: string,
): {
  file: TranslationFile;
  body: Uint8Array;
} {
  const raw = Buffer.from(content.repeat(2_000));
  const body = zlib.zstdCompressSync(raw);
  return {
    body,
    file: {
      path: name,
      bytes: body.byteLength,
      sha256: digest(body),
      decompressedBytes: raw.byteLength,
      decompressedSha256: digest(raw),
    },
  };
}

describe("TranslationFileStore", () => {
  it("downloads, checks and decompresses a model, reporting whole percents", async () => {
    const model = pinned("model.zst", "weights ");
    const { store } = await fixture({ "model.zst": model.body });
    expect(store.has(model.file)).toBe(false);
    const progress: number[] = [];
    await store.ensure([model.file], (fraction) => progress.push(fraction));
    expect(store.has(model.file)).toBe(true);
    expect(await fs.readFile(store.location(model.file), "utf8")).toBe(
      "weights ".repeat(2_000),
    );
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    for (const fraction of progress)
      expect(Number.isInteger(fraction * 100)).toBe(true);
  });

  it("shares one download between callers and skips installed files", async () => {
    const model = pinned("model.zst", "shared ");
    const { store, requests } = await fixture({ "model.zst": model.body });
    const first = store.ensure([model.file]);
    expect(store.downloading([model.file])).toBe(true);
    await Promise.all([first, store.ensure([model.file])]);
    await store.ensure([model.file]);
    expect(requests).toEqual(["model.zst"]);
    expect(store.downloading([model.file])).toBe(false);
  });

  it("keeps nothing that fails its pin", async () => {
    const model = pinned("model.zst", "honest ");
    const { store, root } = await fixture({
      "model.zst": pinned("model.zst", "forged ").body,
    });
    await expect(store.ensure([model.file])).rejects.toThrow();
    expect(store.has(model.file)).toBe(false);
    const left = await fs.readdir(path.join(root, "models"));
    expect(left).toEqual([]);
  });

  it("refuses files from anywhere but Mozilla's CDN", async () => {
    const model = pinned("model.zst", "elsewhere ");
    const store = new TranslationFileStore({
      rootDir: path.join(os.tmpdir(), "never-written"),
      origin: "https://example.com",
    });
    await expect(store.ensure([model.file])).rejects.toThrow(/untrusted/);
  });
});
