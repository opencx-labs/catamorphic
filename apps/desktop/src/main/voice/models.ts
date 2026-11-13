import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { VoiceModelPaths, VoiceStatus } from "../../shared/voice.js";

/** One installed directory of the speech models, from one pinned download. */
export interface VoiceModelArtifact {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  /**
   * The download is a tarball holding one top-level directory, installed
   * as the artifact's directory. Otherwise the file goes in the directory
   * under its own name.
   */
  unpack?: boolean;
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

const PARAKEET: VoiceModelArtifact = {
  id: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
  unpack: true,
  url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
  sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
  bytes: 482_468_385,
};

/** Kokoro-82M v1.0 (Apache 2.0), full precision, with its voices. */
const KOKORO: VoiceModelArtifact = {
  id: "kokoro-multi-lang-v1_0",
  unpack: true,
  url: `${RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
  sha256: "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
  bytes: 349_886_476,
};

/** Only Linux/Windows install recognition; macOS uses Apple's speech APIs. */
export function voiceModelArtifacts(
  platform: NodeJS.Platform,
): readonly VoiceModelArtifact[] {
  return platform === "darwin" ? [KOKORO] : [PARAKEET, KOKORO];
}

/**
 * Where the models are served from: GitHub releases, and the content host
 * they redirect to. The SHA-256 pin is what makes a file trusted; the
 * hosts only keep a download from wandering elsewhere.
 */
const TRUSTED_HOSTS = ["github.com"];
const TRUSTED_HOST_SUFFIXES = [".githubusercontent.com"];

/** The files the worker loads, inside a models directory. */
export function voiceModelPaths(root: string): VoiceModelPaths {
  const asr = path.join(root, PARAKEET.id);
  const tts = path.join(root, KOKORO.id);
  return {
    recognition: {
      kind: "parakeet",
      encoder: path.join(asr, "encoder.int8.onnx"),
      decoder: path.join(asr, "decoder.int8.onnx"),
      joiner: path.join(asr, "joiner.int8.onnx"),
      tokens: path.join(asr, "tokens.txt"),
    },
    tts: {
      model: path.join(tts, "model.onnx"),
      voices: path.join(tts, "voices.bin"),
      tokens: path.join(tts, "tokens.txt"),
      lexicon: path.join(tts, "lexicon-us-en.txt"),
      dataDir: path.join(tts, "espeak-ng-data"),
    },
  };
}

type VoiceModelProgress = NonNullable<VoiceStatus["download"]>;

/**
 * The speech models on disk. `ensure` downloads what is missing, verifies
 * each file against its SHA-256 pin while it streams, unpacks archives in
 * a staging directory and moves each into place in one rename, so an
 * interrupted install never leaves a half-written model behind.
 */
export class VoiceModelStore {
  private pending: Promise<VoiceModelPaths> | null = null;
  /** Who hears the install's progress: the latest to ask for the models. */
  private onProgress: (progress: VoiceModelProgress) => void = () => {};

  constructor(
    private readonly options: {
      rootDir: string;
      artifacts?: readonly VoiceModelArtifact[];
      nativeRecognition?: { helperPath: string; locale: string };
      fetchImpl?: typeof fetch;
      paths?: (root: string) => VoiceModelPaths;
    },
  ) {}

  private get artifacts(): readonly VoiceModelArtifact[] {
    return (
      this.options.artifacts ??
      voiceModelArtifacts(this.options.nativeRecognition ? "darwin" : "linux")
    );
  }

  ensure(
    onProgress: (progress: VoiceModelProgress) => void = () => {},
    { dictation = false }: { dictation?: boolean } = {},
  ): Promise<VoiceModelPaths> {
    // Apple's recognizer has no Work models. Dictation must not wait for
    // (or fail because of) the unrelated voice used to speak replies.
    if (dictation && this.options.nativeRecognition)
      return Promise.resolve(this.paths());
    // Voice turned off and on mid-download waits on the same install, and
    // shows its progress from here on.
    this.onProgress = onProgress;
    this.pending ??= this.install((progress) =>
      this.onProgress(progress),
    ).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private marker(artifact: VoiceModelArtifact): string {
    return path.join(this.options.rootDir, artifact.id, ".integrity");
  }

  private paths(): VoiceModelPaths {
    const paths = (this.options.paths ?? voiceModelPaths)(this.options.rootDir);
    return this.options.nativeRecognition
      ? {
          ...paths,
          recognition: { kind: "native", ...this.options.nativeRecognition },
        }
      : paths;
  }

  private isInstalled(artifact: VoiceModelArtifact): boolean {
    try {
      return (
        fs.readFileSync(this.marker(artifact), "utf8").trim() ===
        artifact.sha256
      );
    } catch {
      return false;
    }
  }

  private async install(
    onProgress: (progress: VoiceModelProgress) => void,
  ): Promise<VoiceModelPaths> {
    const missing = this.artifacts.filter(
      (artifact) => !this.isInstalled(artifact),
    );
    const totalBytes = missing.reduce(
      (sum, artifact) => sum + artifact.bytes,
      0,
    );
    const received = new Map<string, number>();
    let lastTick = 0;
    const tick = (id: string, bytes: number, force = false) => {
      received.set(id, bytes);
      if (!force && Date.now() - lastTick < 200) return;
      lastTick = Date.now();
      let receivedBytes = 0;
      for (const value of received.values()) receivedBytes += value;
      onProgress({
        receivedBytes,
        totalBytes,
        kind: missing.every((artifact) => artifact.id === KOKORO.id)
          ? "reply-voice"
          : "speech",
      });
    };
    if (missing.length > 0) tick("", 0, true);
    await fsPromises.mkdir(this.options.rootDir, { recursive: true });
    await Promise.all(
      missing.map((artifact) =>
        this.installArtifact(artifact, (bytes) => tick(artifact.id, bytes)),
      ),
    );
    if (missing.length > 0) {
      tick("", 0, true);
      await this.prune();
    }
    return this.paths();
  }

  /**
   * Models a newer catalog replaced are removed after an install: only
   * directories this store installed, by their integrity marker.
   */
  private async prune(): Promise<void> {
    const current = new Set(this.artifacts.map((artifact) => artifact.id));
    const entries = await fsPromises.readdir(this.options.rootDir);
    await Promise.all(
      entries
        .filter(
          (name) =>
            !current.has(name) &&
            fs.existsSync(path.join(this.options.rootDir, name, ".integrity")),
        )
        .map((name) =>
          fsPromises
            .rm(path.join(this.options.rootDir, name), {
              recursive: true,
              force: true,
            })
            .catch(() => {}),
        ),
    );
  }

  private async installArtifact(
    artifact: VoiceModelArtifact,
    onBytes: (bytes: number) => void,
  ): Promise<void> {
    const root = this.options.rootDir;
    const staging = await fsPromises.mkdtemp(path.join(root, ".install-"));
    try {
      let installed = path.join(staging, "files");
      await fsPromises.mkdir(installed);
      const download = path.join(
        artifact.unpack ? staging : installed,
        path.basename(new URL(artifact.url).pathname),
      );
      await this.download(artifact, download, onBytes);
      if (artifact.unpack) {
        await untar(download, installed);
        const [top, ...rest] = await fsPromises.readdir(installed);
        if (!top || rest.length > 0)
          throw new Error(
            `${artifact.id}: expected one directory in the archive`,
          );
        installed = path.join(installed, top);
      }
      await fsPromises.writeFile(
        path.join(installed, ".integrity"),
        `${artifact.sha256}\n`,
        { mode: 0o600 },
      );
      const target = path.join(root, artifact.id);
      await fsPromises.rm(target, { recursive: true, force: true });
      await fsPromises.rename(installed, target);
    } finally {
      await fsPromises.rm(staging, { recursive: true, force: true });
    }
  }

  private async download(
    { id, url, sha256, bytes }: VoiceModelArtifact,
    destination: string,
    onBytes: (bytes: number) => void,
  ): Promise<void> {
    assertTrusted(url);
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      redirect: "follow",
    });
    if (response.url) assertTrusted(response.url);
    if (!response.ok)
      throw new Error(`${id}: download failed (HTTP ${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${id}: download has no body`);
    const handle = await fsPromises.open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > bytes)
          throw new Error(`${id}: download is larger than pinned`);
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.byteLength - offset,
          );
          offset += bytesWritten;
        }
        onBytes(received);
      }
    } finally {
      await handle.close();
    }
    if (received !== bytes || hash.digest("hex") !== sha256)
      throw new Error(`${id}: integrity verification failed`);
  }
}

function assertTrusted(url: string): void {
  const parsed = new URL(url);
  // Loopback serves tests; every real asset comes over HTTPS.
  const loopback =
    parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  const trusted =
    TRUSTED_HOSTS.includes(parsed.hostname) ||
    TRUSTED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
  if (!loopback && (parsed.protocol !== "https:" || !trusted))
    throw new Error(`refusing untrusted model URL ${parsed.origin}`);
}

/**
 * The system `tar` (bsdtar on macOS and Windows, GNU tar on Linux) unpacks
 * bzip2 natively and far faster than a JavaScript decoder.
 */
function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", into], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Unpacking a speech model failed: ${stderr.trim() || `tar exited ${code}`}`,
            ),
          ),
    );
  });
}
