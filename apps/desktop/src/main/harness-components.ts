import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export type DownloadableHarness = "claude-code" | "codex";
export type DownloadableComponent = DownloadableHarness | "bun";

export interface HarnessExecutable {
  executablePath: string;
  /** Directories the Codex SDK normally prepends when resolving its package. */
  pathEntries: readonly string[];
  source: "installed" | "downloaded";
}

/** Environment additions needed beside an explicitly selected executable. */
export function harnessPathEnvironment(
  component: Pick<HarnessExecutable, "pathEntries">,
): Record<string, string> {
  if (component.pathEntries.length === 0) return {};
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  return {
    [pathKey]: [...component.pathEntries, process.env[pathKey]]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter),
  };
}

export interface HarnessArtifact {
  displayName: string;
  version: string;
  packageName: string;
  installedPackageName: string;
  tarballUrl: string;
  integrity: `sha512-${string}`;
  executableRelativePath: string;
  pathEntryRelativePaths: readonly string[];
}

interface HarnessComponentStoreOptions {
  rootDir: string;
  artifacts?: Partial<Record<DownloadableComponent, HarnessArtifact>>;
  fetchImpl?: typeof fetch;
  preferInstalled?: boolean;
}

interface PlatformRelease {
  rustTarget: string;
  claudeIntegrity: `sha512-${string}`;
  codexIntegrity: `sha512-${string}`;
  bunIntegrity: `sha512-${string}`;
}

const CLAUDE_VERSION = "0.3.263";
const CODEX_VERSION = "0.153.4";
const BUN_VERSION = "1.3.14";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

const PLATFORM_RELEASES: Record<string, PlatformRelease> = {
  "darwin-arm64": {
    rustTarget: "aarch64-apple-darwin",
    claudeIntegrity:
      "sha512-H4eLd4Tkx3rJkt739CHb+9AcaKiiOpibU4tYsmma47mV+2zAPjUyFxpuE2N57VSmpAgbLQxu44du0TFN+UH5dg==",
    codexIntegrity:
      "sha512-B1qhN3fa1ay0R0wGziXqgwSkB5icpYChNKHhtBHff/0UtSTC7z+l8aTtvMlGjH3E8HEvY3+njIJelM9CAAoVWg==",
    bunIntegrity:
      "sha512-Omj20SuiHBOUjUBIyqtkNjSUIjOtEOJwmbix/ZyFH4BaQ6OZTaaRWIR4TjHVz0yadHgli6lLTiAh1uarnvD49A==",
  },
  "darwin-x64": {
    rustTarget: "x86_64-apple-darwin",
    claudeIntegrity:
      "sha512-jKwmfkem1s/TcK7u83cJf2zLHMz846irV4vqYGUlo74uX2qfX57R4UsrCMlcTUMou/U9vQyNCc/Kk0s+zSxYRg==",
    codexIntegrity:
      "sha512-vnSbbPzfoDZmmyzsxswsDDXQ06IVFBzkQU7/hroB3ji93Ok2utcsq8Psfk2tjF5r9mEx8RWFJhzuTGHG26/NDA==",
    bunIntegrity:
      "sha512-FFj3QdU/OhlDyZOJ8CWfN5eWLpRlT4qjZg7lMQi7jA6GuoY5ajlO1zWLP/MuHYRSbXQUvV52RejNi8DVnAp13w==",
  },
  "linux-arm64": {
    rustTarget: "aarch64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-2KPY1wu1hdjpVsw+Tg3i50uhxhhetO1fB24wjUJAQJ8YPSogqO32UbtYPJ6I3F17lBNHb/Mq3nRYGAuSU5yjtg==",
    codexIntegrity:
      "sha512-QKdjYLYV4hXIuUQDP3P6F4NXuWFoKo9WUoV4nAREIx55kiUyi8UsYdsVobkeXir5n/maEQgYMCKLHVma4rNPiw==",
    bunIntegrity:
      "sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==",
  },
  "linux-x64": {
    rustTarget: "x86_64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-un7HJzTT+DSQLgM33emQ0qHAwIY3CXIwe8JXoD9PaT7pdLepK4Ffa4r5j84pHTVS5uoGqxcf196tBgqb5/Z7FA==",
    codexIntegrity:
      "sha512-x1EcwBlY3AObM1VTUHNM2AzAJQsyreGdagpF+qFiYi/Oa30VBktvvG0C6tLtCzqW6hjZNWkGZQWmeVk7MuJKWg==",
    bunIntegrity:
      "sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==",
  },
  "win32-arm64": {
    rustTarget: "aarch64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-n8owOwNSSi7/KpONb/ut+uXRjBIp9N6EjwADiB+YygPwGRtpWP+PR/qFsGdTVBE5cpPwhgKVAf27xEZEfNvcSQ==",
    codexIntegrity:
      "sha512-/FBh42976ltF1kxDoPQBg1Q6+hwChRU5/sm5dfeC8kFVQMvOCGoGeY5d8rRZGVJE8XojlXo74VQb0sHowcfgBw==",
    bunIntegrity:
      "sha512-T7s3x/BsVKQObGU6QDkZeI6wKynzqGbBH1yI77jrrj5siElclxr3DQrDIk8CV4G5/SJq2HHq4kpLyYY2DKCSmA==",
  },
  "win32-x64": {
    rustTarget: "x86_64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-EwqzsOLxIJTX6RIXtQ21ekOKmYBNfwbtGtqaPqdWZGzpMbHaie8kGsM630h9RFaoxeytS/jbg8B3fPCdUKfhPw==",
    codexIntegrity:
      "sha512-lMkB43kJZH0VFr+hoXc11qqR7QtQIbkr07ALgj4urKL1osNyUyuy1iXd3Vzz2iCYvBUCSw7I0l/W1cEPGx9euQ==",
    bunIntegrity:
      "sha512-mUFWL3BoYkNpjd8e9PqROiFF/1Xeotq20mABJsiQH62jM1g5zqWh4khw1RZ6bX8Q8fWvlPaxG1PjofkmjUi3vg==",
  },
};

/**
 * App-owned store for the large native payloads behind the Claude Code and
 * Codex SDKs. The TypeScript SDKs remain packaged and audited with the app;
 * only their exact, platform-specific executables arrive on first use.
 */
export class HarnessComponentStore {
  private readonly rootDir: string;
  private readonly artifacts: Partial<
    Record<DownloadableComponent, HarnessArtifact>
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly preferInstalled: boolean;
  private readonly pending = new Map<
    DownloadableComponent,
    Promise<HarnessExecutable>
  >();

  constructor(options: HarnessComponentStoreOptions) {
    this.rootDir = options.rootDir;
    this.artifacts = options.artifacts ?? platformArtifacts();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.preferInstalled = options.preferInstalled ?? true;
  }

  async ensure(harness: DownloadableComponent): Promise<HarnessExecutable> {
    const artifact = this.artifacts[harness];
    if (!artifact) {
      throw new Error(
        `${displayName(harness)} is unavailable on ${process.platform}-${process.arch}.`,
      );
    }
    if (this.preferInstalled) {
      const installed = resolveInstalled(artifact);
      if (installed) return installed;
    }
    const existing = await this.resolveDownloaded(harness, artifact);
    if (existing) return existing;
    const active = this.pending.get(harness);
    if (active) return active;
    const installing = this.install(harness, artifact).finally(() => {
      this.pending.delete(harness);
    });
    this.pending.set(harness, installing);
    return installing;
  }

  private componentDir(
    harness: DownloadableComponent,
    artifact: HarnessArtifact,
  ): string {
    return path.join(
      this.rootDir,
      harness,
      artifact.version,
      `${process.platform}-${process.arch}`,
    );
  }

  private async resolveDownloaded(
    harness: DownloadableComponent,
    artifact: HarnessArtifact,
  ): Promise<HarnessExecutable | null> {
    const root = this.componentDir(harness, artifact);
    try {
      const [marker, stat] = await Promise.all([
        fsPromises.readFile(path.join(root, ".integrity"), "utf8"),
        fsPromises.stat(path.join(root, artifact.executableRelativePath)),
      ]);
      if (marker.trim() !== artifact.integrity || !stat.isFile()) return null;
      return executableAt(root, artifact, "downloaded");
    } catch {
      return null;
    }
  }

  private async install(
    harness: DownloadableComponent,
    artifact: HarnessArtifact,
  ): Promise<HarnessExecutable> {
    assertTrustedArtifact(artifact);
    const finalDir = this.componentDir(harness, artifact);
    const parentDir = path.dirname(finalDir);
    await fsPromises.mkdir(parentDir, { recursive: true });
    const stagingDir = await fsPromises.mkdtemp(
      path.join(parentDir, ".install-"),
    );
    const archive = path.join(stagingDir, "component.tgz");
    const payload = path.join(stagingDir, "payload");
    try {
      const response = await this.fetchImpl(artifact.tarballUrl, {
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        throw new Error(`download returned HTTP ${response.status}`);
      }
      await writeVerifiedArchive(response, archive, artifact.integrity);
      await fsPromises.mkdir(payload);
      const { x: extract } = await import("tar");
      await extract({
        file: archive,
        cwd: payload,
        strip: 1,
        preservePaths: false,
        strict: true,
      });
      const executable = path.join(payload, artifact.executableRelativePath);
      const stat = await fsPromises.stat(executable);
      if (!stat.isFile()) throw new Error("archive contains no executable");
      if (process.platform !== "win32") {
        await fsPromises.chmod(executable, 0o755);
      }
      await fsPromises.writeFile(
        path.join(payload, ".integrity"),
        `${artifact.integrity}\n`,
        { mode: 0o600 },
      );
      await fsPromises.rm(finalDir, { recursive: true, force: true });
      await fsPromises.rename(payload, finalDir);
      console.info(
        `[desktop] Installed ${artifact.displayName} ${artifact.version} optional component`,
      );
      return executableAt(finalDir, artifact, "downloaded");
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${artifact.displayName} needs a one-time component download. ${reason}. Check your internet connection and try again.`,
        { cause },
      );
    } finally {
      await fsPromises.rm(stagingDir, { recursive: true, force: true });
    }
  }
}

function platformArtifacts(): Partial<
  Record<DownloadableComponent, HarnessArtifact>
> {
  const target = `${process.platform}-${process.arch}`;
  const release = PLATFORM_RELEASES[target];
  if (!release) return {};
  const executable = process.platform === "win32" ? ".exe" : "";
  const claudePackage = `@anthropic-ai/claude-agent-sdk-${target}`;
  const bunPlatform =
    process.platform === "win32" ? "windows" : process.platform;
  const bunArch = process.arch === "arm64" ? "aarch64" : process.arch;
  const bunPackage = `@oven/bun-${bunPlatform}-${bunArch}`;
  return {
    "claude-code": {
      displayName: "Claude Code",
      version: CLAUDE_VERSION,
      packageName: claudePackage,
      installedPackageName: claudePackage,
      tarballUrl: `https://registry.npmjs.org/${claudePackage}/-/claude-agent-sdk-${target}-${CLAUDE_VERSION}.tgz`,
      integrity: release.claudeIntegrity,
      executableRelativePath: `claude${executable}`,
      pathEntryRelativePaths: [],
    },
    codex: {
      displayName: "Codex",
      version: CODEX_VERSION,
      packageName: "@openai/codex",
      installedPackageName: `@openai/codex-${target}`,
      tarballUrl: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-${target}.tgz`,
      integrity: release.codexIntegrity,
      executableRelativePath: path.join(
        "vendor",
        release.rustTarget,
        "bin",
        `codex${executable}`,
      ),
      pathEntryRelativePaths: [
        path.join("vendor", release.rustTarget, "codex-path"),
      ],
    },
    bun: {
      displayName: "Bun",
      version: BUN_VERSION,
      packageName: bunPackage,
      installedPackageName: bunPackage,
      tarballUrl: `https://registry.npmjs.org/${bunPackage}/-/bun-${bunPlatform}-${bunArch}-${BUN_VERSION}.tgz`,
      integrity: release.bunIntegrity,
      executableRelativePath: path.join("bin", `bun${executable}`),
      pathEntryRelativePaths: ["bin"],
    },
  };
}

function resolveInstalled(artifact: HarnessArtifact): HarnessExecutable | null {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve(
      `${artifact.installedPackageName}/package.json`,
    );
    const root = path.dirname(packageJson);
    const executable = path.join(root, artifact.executableRelativePath);
    if (!fs.statSync(executable).isFile()) return null;
    return executableAt(root, artifact, "installed");
  } catch {
    return null;
  }
}

function executableAt(
  root: string,
  artifact: HarnessArtifact,
  source: HarnessExecutable["source"],
): HarnessExecutable {
  return {
    executablePath: path.join(root, artifact.executableRelativePath),
    pathEntries: artifact.pathEntryRelativePaths
      .map((entry) => path.join(root, entry))
      .filter((entry) => fs.existsSync(entry)),
    source,
  };
}

function assertTrustedArtifact(artifact: HarnessArtifact): void {
  const url = new URL(artifact.tarballUrl);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error(`refusing untrusted component URL ${url.origin}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(artifact.integrity)) {
    throw new Error("component has no valid SHA-512 integrity pin");
  }
}

async function writeVerifiedArchive(
  response: Response,
  destination: string,
  expectedIntegrity: `sha512-${string}`,
): Promise<void> {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error("component archive is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("component download has no body");
  const handle = await fsPromises.open(destination, "wx", 0o600);
  const hash = createHash("sha512");
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error("component archive is too large");
      }
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
    }
  } finally {
    await handle.close();
  }
  const actualIntegrity = `sha512-${hash.digest("base64")}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error("component integrity verification failed");
  }
}

function displayName(harness: DownloadableComponent): string {
  if (harness === "claude-code") return "Claude Code";
  return harness === "codex" ? "Codex" : "Bun";
}
