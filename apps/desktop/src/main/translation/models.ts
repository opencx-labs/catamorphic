import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/** One file of the engine or a language model, pinned in catalog.json. */
export interface TranslationFile {
  /** Where it is, relative to the files' origin. */
  path: string;
  /** The zstd download's size and SHA-256. */
  bytes: number;
  sha256: string;
  /** The file's size and SHA-256 once decompressed. */
  decompressedBytes: number;
  decompressedSha256: string;
}

/**
 * Where Firefox's translation files are served from. The SHA-256 pins are
 * what make a file trusted; the origin only keeps a download from
 * wandering elsewhere.
 */
export const TRANSLATION_FILES_ORIGIN =
  "https://firefox-settings-attachments.cdn.mozilla.net";

interface Download {
  done: Promise<void>;
  received: number;
  listeners: Set<() => void>;
}

/**
 * The engine and language models on disk, one file per decompressed
 * SHA-256. `ensure` downloads what is missing, checks the download and the
 * decompressed file against their pins while they stream, and moves each
 * into place in one rename, so an interrupted download never leaves a
 * half-written model behind. Pages asking for the same file share one
 * download.
 */
export class TranslationFileStore {
  private readonly downloads = new Map<string, Download>();

  constructor(
    private readonly options: {
      rootDir: string;
      origin?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  location(file: TranslationFile): string {
    return path.join(this.options.rootDir, `${file.decompressedSha256}.bin`);
  }

  has(file: TranslationFile): boolean {
    return fs.existsSync(this.location(file));
  }

  /** Whether any of these files is downloading now. */
  downloading(files: readonly TranslationFile[]): boolean {
    return files.some((file) => this.downloads.has(file.decompressedSha256));
  }

  /**
   * Downloads the missing files, reporting the share of their bytes
   * received so far, from 0 to 1 in whole percents.
   */
  async ensure(
    files: readonly TranslationFile[],
    onProgress: (fraction: number) => void = () => {},
  ): Promise<void> {
    const missing = files.filter((file) => !this.has(file));
    if (missing.length === 0) return;
    const total = missing.reduce((sum, file) => sum + file.bytes, 0);
    const downloads = missing.map((file) => this.download(file));
    let last = -1;
    const tick = () => {
      const received = downloads.reduce(
        (sum, download) => sum + download.received,
        0,
      );
      // Whole percents: a page hears each step once, as Chrome reports.
      const fraction = Math.floor(100 * Math.min(1, received / total)) / 100;
      if (fraction === last) return;
      last = fraction;
      onProgress(fraction);
    };
    for (const download of downloads) download.listeners.add(tick);
    tick();
    try {
      await Promise.all(downloads.map((download) => download.done));
    } finally {
      for (const download of downloads) download.listeners.delete(tick);
    }
  }

  private download(file: TranslationFile): Download {
    const key = file.decompressedSha256;
    const existing = this.downloads.get(key);
    if (existing) return existing;
    const download: Download = {
      received: 0,
      listeners: new Set(),
      done: Promise.resolve(),
    };
    download.done = this.fetchFile(file, (received) => {
      download.received = received;
      for (const listener of download.listeners) listener();
    }).finally(() => this.downloads.delete(key));
    this.downloads.set(key, download);
    return download;
  }

  private async fetchFile(
    file: TranslationFile,
    onBytes: (received: number) => void,
  ): Promise<void> {
    const origin = this.options.origin ?? TRANSLATION_FILES_ORIGIN;
    const url = new URL(file.path, `${origin}/`);
    assertTrusted(url);
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Downloading a translation model failed (HTTP ${response.status})`,
      );
    await fsPromises.mkdir(this.options.rootDir, { recursive: true });
    const staging = path.join(
      this.options.rootDir,
      `.${file.decompressedSha256}.${process.pid}.${Date.now()}.part`,
    );
    const compressed = createHash("sha256");
    const decompressed = createHash("sha256");
    let received = 0;
    let written = 0;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.byteLength;
            if (received > file.bytes) {
              callback(new Error("A translation model is larger than pinned"));
              return;
            }
            compressed.update(chunk);
            onBytes(received);
            callback(null, chunk);
          },
        }),
        zlib.createZstdDecompress(),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            written += chunk.byteLength;
            if (written > file.decompressedBytes) {
              callback(new Error("A translation model is larger than pinned"));
              return;
            }
            decompressed.update(chunk);
            callback(null, chunk);
          },
        }),
        fs.createWriteStream(staging, { flags: "wx", mode: 0o600 }),
      );
      if (
        received !== file.bytes ||
        compressed.digest("hex") !== file.sha256 ||
        written !== file.decompressedBytes ||
        decompressed.digest("hex") !== file.decompressedSha256
      )
        throw new Error("A translation model failed its integrity check");
      await fsPromises.rename(staging, this.location(file));
    } finally {
      await fsPromises.rm(staging, { force: true });
    }
  }
}

function assertTrusted(url: URL): void {
  // Loopback serves tests; every real file comes over HTTPS from Mozilla.
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
  const trusted =
    url.protocol === "https:" &&
    url.origin === new URL(TRANSLATION_FILES_ORIGIN).origin;
  if (!loopback && !trusted)
    throw new Error(`Refusing an untrusted translation model at ${url.origin}`);
}
