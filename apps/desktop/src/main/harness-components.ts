import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import type { ClaudeCodeInstallStatus } from "../shared/claude-code-install.js";
import {
  compareVersions,
  type InstalledClaudeCodeFinder,
} from "./installed-claude-code.js";

export type { ClaudeCodeInstallStatus };

export type DownloadableHarness = "claude-code" | "codex";
export type DownloadableComponent = DownloadableHarness | "bun";

export interface HarnessExecutable {
  executablePath: string;
  /** Directories the Codex SDK normally prepends when resolving its package. */
  pathEntries: readonly string[];
  /**
   * `system`: the person's own install (ADR 0196); `installed`: a package
   * beside the app (development); `downloaded`: Work's pinned copy.
   */
  source: "system" | "installed" | "downloaded";
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
  /** The person's own Claude Code, preferred when new enough (ADR 0196). */
  installedClaudeCode?: Pick<InstalledClaudeCodeFinder, "find" | "update">;
  /** How long a download may go without a byte before it gives up. */
  stallTimeoutMs?: number;
}

/** One tick of a first-use component download, for "Downloading… 42%" UI. */
export interface HarnessDownloadProgress {
  harness: DownloadableComponent;
  displayName: string;
  receivedBytes: number;
  /** 0 when the registry declared no content-length. */
  totalBytes: number;
}

/**
 * A chat's activity line while its turn waits for first-use downloads,
 * all of them at once, by the megabyte so a slow link still moves:
 * "Downloading Claude Code and Bun: 63 of 124 MB", then "Setting up
 * Claude Code and Bun" while the archives unpack.
 */
export function harnessDownloadLine(
  downloads: readonly HarnessDownloadProgress[],
): string {
  const names = downloads.map((download) => download.displayName).join(" and ");
  const received = downloads.reduce(
    (sum, download) => sum + download.receivedBytes,
    0,
  );
  const known = downloads.every((download) => download.totalBytes > 0);
  const total = downloads.reduce(
    (sum, download) => sum + download.totalBytes,
    0,
  );
  if (known && received >= total) return `Setting up ${names}`;
  const megabytes = (bytes: number) => Math.floor(bytes / 1_000_000);
  return known
    ? `Downloading ${names}: ${megabytes(received)} of ${Math.round(total / 1_000_000)} MB`
    : `Downloading ${names}: ${megabytes(received)} MB`;
}

interface PlatformRelease {
  rustTarget: string;
  claudeIntegrity: `sha512-${string}`;
  codexIntegrity: `sha512-${string}`;
  bunIntegrity: `sha512-${string}`;
}

const CLAUDE_VERSION = "0.3.299";
/**
 * The Claude Code CLI release the bundled Agent SDK ships with: an installed
 * Claude Code at this version or newer runs instead of Work's own copy
 * (ADR 0196). scripts/harness-bump.ts moves it with CLAUDE_VERSION.
 */
export const CLAUDE_CODE_MIN_VERSION = "2.1.299";
const CODEX_VERSION = "0.162.1";
const BUN_VERSION = "1.3.14";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
/**
 * A download that receives nothing for this long has stalled: a slow link
 * still delivers bytes, a dropped one never errors by itself.
 */
const STALL_TIMEOUT_MS = 60_000;

const PLATFORM_RELEASES: Record<string, PlatformRelease> = {
  "darwin-arm64": {
    rustTarget: "aarch64-apple-darwin",
    claudeIntegrity:
      "sha512-KfkR3Ve7Eku1QuxT3LhC5e9Oj7c8UXvLJFFLbCw0u3OrhpzJUQ0ldd9ArmYNU3J47gpaqYgafnk9ztVPLdcajA==",
    codexIntegrity:
      "sha512-YVXpg57itBuQxjofay3KDF5UbnZF4Y1ZmNFzUCz0ZQiQN+DndxOjN5V87rnXvPaC4qCPO2El74DzewoBP8JyPQ==",
    bunIntegrity:
      "sha512-Omj20SuiHBOUjUBIyqtkNjSUIjOtEOJwmbix/ZyFH4BaQ6OZTaaRWIR4TjHVz0yadHgli6lLTiAh1uarnvD49A==",
  },
  "darwin-x64": {
    rustTarget: "x86_64-apple-darwin",
    claudeIntegrity:
      "sha512-7G6qjn+xNCmyewcQ/XG/ElBoEGr8uDD4D8X33bqXEbNZ4vXbssiOzmcyxfuWLa7YqR8g9cJnmaWB6UzFEwiC6Q==",
    codexIntegrity:
      "sha512-0/WHRhbUnM1wAjfyCO54Q8s4vQRxLVBbqW6XuQf7rZTEMTYPKRIQU9aPeRgjG653ZCSjtBrslWQ+G9urY9CksQ==",
    bunIntegrity:
      "sha512-FFj3QdU/OhlDyZOJ8CWfN5eWLpRlT4qjZg7lMQi7jA6GuoY5ajlO1zWLP/MuHYRSbXQUvV52RejNi8DVnAp13w==",
  },
  "linux-arm64": {
    rustTarget: "aarch64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-8b5apRvHageZ/9xDfoIu8tJ6lpPAGjg4tD9JYef4SjpsY4KM/gvR6qC+Kqq5JHiH/Tq/mjgGYZjMkTZS8TOnsQ==",
    codexIntegrity:
      "sha512-Ss7W/SrKtQFNaMtSojNoiykJgX+iDC8daM+YrcvgmJADtQPk0cd3w6Dna4CYH2CYvf9nQranj69fpcTzZ3sQIQ==",
    bunIntegrity:
      "sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==",
  },
  "linux-x64": {
    rustTarget: "x86_64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-Q+sweKF/ruNq4Gmf4CzglwaKJmtQjhBK5MT3U1oUhlNStwHejgBg1GLa/KrQMRE0R4u0ayapLyVNrfu0hQYGkQ==",
    codexIntegrity:
      "sha512-cjK2mdHIfEepZ1lQ1MX3aTQC+8ncIsvnacl/6vI2dIIcfP8/MrhTQ2+qRlkXFNDzJSj1d36quIszP+3/4CUJWQ==",
    bunIntegrity:
      "sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==",
  },
  "win32-arm64": {
    rustTarget: "aarch64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-sKvddLLYlXzk0FwjT9gNZDzmdzupI7qI0Dok7uu/KYGFgMGiSEGIsB9bfg+31HMDDftaT16P80MLzH+F8zQBFA==",
    codexIntegrity:
      "sha512-teVVACnEcupkR6XSmUQKwlGg/oA15d1DQDPVSoAfilHgctPEpTi5y11jYS6JhJO+AFnYM84gyo5SOS5vlnCQSg==",
    bunIntegrity:
      "sha512-T7s3x/BsVKQObGU6QDkZeI6wKynzqGbBH1yI77jrrj5siElclxr3DQrDIk8CV4G5/SJq2HHq4kpLyYY2DKCSmA==",
  },
  "win32-x64": {
    rustTarget: "x86_64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-PWHbjAdrecVlmR0kdgsX20QvUiFgWQl4zskuWd6Ieg3e5w+Ol0FZGXYRLS+Erd+pYUEZBNjDCqK2yd2KdBbDQw==",
    codexIntegrity:
      "sha512-dfl4MhHuEi0ARKyNmrTxk+RQmsWNCQAoVLUtrYq+yrW1C8P2sg5ziwgHUUACHjYLKuACV7ARH5Nq5pnCz3GlaQ==",
    bunIntegrity:
      "sha512-mUFWL3BoYkNpjd8e9PqROiFF/1Xeotq20mABJsiQH62jM1g5zqWh4khw1RZ6bX8Q8fWvlPaxG1PjofkmjUi3vg==",
  },
};

/**
 * App-owned store for the large native payloads behind the Claude Code and
 * Codex SDKs. The TypeScript SDKs remain packaged and audited with the app;
 * only their exact, platform-specific executables arrive on first use, and
 * Claude Code's not at all when the person's own install is new enough.
 */
export class HarnessComponentStore {
  private readonly rootDir: string;
  private readonly artifacts: Partial<
    Record<DownloadableComponent, HarnessArtifact>
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly preferInstalled: boolean;
  private readonly installedClaudeCode?: Pick<
    InstalledClaudeCodeFinder,
    "find" | "update"
  >;
  private readonly stallTimeoutMs: number;
  private readonly pending = new Map<
    DownloadableComponent,
    Promise<HarnessExecutable>
  >();

  private readonly progressListeners = new Set<
    (progress: HarnessDownloadProgress) => void
  >();

  constructor(options: HarnessComponentStoreOptions) {
    this.rootDir = options.rootDir;
    this.artifacts = options.artifacts ?? platformArtifacts();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.preferInstalled = options.preferInstalled ?? true;
    this.installedClaudeCode = options.installedClaudeCode;
    this.stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  }

  /**
   * Which Claude Code runs: the person's own when it is at least the
   * version the bundled SDK ships with, else Work's pinned copy.
   */
  async claudeCodeStatus(): Promise<ClaudeCodeInstallStatus> {
    const installed =
      (await this.installedClaudeCode?.find().catch(() => null)) ?? null;
    return {
      using:
        installed &&
        compareVersions(installed.version, CLAUDE_CODE_MIN_VERSION) >= 0
          ? "installed"
          : "work",
      installed,
      minVersion: CLAUDE_CODE_MIN_VERSION,
    };
  }

  /** Update the person's own Claude Code with its updater, when they ask. */
  async updateInstalledClaudeCode(): Promise<{
    output: string;
    status: ClaudeCodeInstallStatus;
  }> {
    const before = await this.claudeCodeStatus();
    if (!before.installed || !this.installedClaudeCode)
      throw new Error("Claude Code is not installed on this computer.");
    const output = await this.installedClaudeCode
      .update(before.installed)
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );
    return { output, status: await this.claudeCodeStatus() };
  }

  /** Watch first-use downloads; silent when the component is already here. */
  onProgress(
    listener: (progress: HarnessDownloadProgress) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async ensure(harness: DownloadableComponent): Promise<HarnessExecutable> {
    const artifact = this.artifacts[harness];
    if (!artifact) {
      throw new Error(
        `${componentDisplayName(harness)} is unavailable on ${process.platform}-${process.arch}.`,
      );
    }
    if (harness === "claude-code") {
      const status = await this.claudeCodeStatus();
      if (status.using === "installed" && status.installed)
        return {
          executablePath: status.installed.executablePath,
          pathEntries: [],
          source: "system",
        };
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
    // Every byte restarts the clock, from the request until the body ends.
    const stall = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stall.abort(), this.stallTimeoutMs);
    };
    try {
      alive();
      const response = await this.fetchImpl(artifact.tarballUrl, {
        redirect: "error",
        signal: stall.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`download returned HTTP ${response.status}`);
      }
      await writeVerifiedArchive(
        response,
        archive,
        artifact.integrity,
        (receivedBytes, totalBytes) => {
          alive();
          for (const listener of this.progressListeners) {
            // A watcher's mistake never fails the download others wait on.
            try {
              listener({
                harness,
                displayName: artifact.displayName,
                receivedBytes,
                totalBytes,
              });
            } catch (error) {
              console.warn(
                "[desktop] Download progress listener failed",
                error,
              );
            }
          }
        },
      );
      clearTimeout(watchdog);
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
      const reason = stall.signal.aborted
        ? `The download received nothing for ${Math.round(this.stallTimeoutMs / 1000)} seconds`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new Error(
        `${artifact.displayName} needs a one-time component download. ${reason}. Check your internet connection and try again.`,
        { cause },
      );
    } finally {
      clearTimeout(watchdog);
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
  // Package managers keep the platform alias beside the Codex CLI, nested
  // beneath the SDK. It is not necessarily visible from the desktop package.
  const dependencyPaths = [
    [artifact.installedPackageName],
    ...(artifact.packageName === "@openai/codex"
      ? [
          [
            "@catamorphic/codex",
            "@openai/codex-sdk",
            "@openai/codex",
            artifact.installedPackageName,
          ],
        ]
      : []),
  ];
  for (const dependencies of dependencyPaths) {
    try {
      let containingModule = import.meta.url;
      for (const dependency of dependencies) {
        const packageJson = findPackageJSON(dependency, containingModule);
        if (!packageJson)
          throw new Error("Optional component is not installed");
        containingModule = fs.realpathSync(packageJson);
      }
      const root = path.dirname(containingModule);
      const executable = path.join(root, artifact.executableRelativePath);
      if (!fs.statSync(executable).isFile()) continue;
      return executableAt(root, artifact, "installed");
    } catch {
      // An optional dependency may be absent in a packaged desktop. The
      // integrity-pinned download remains the fallback in that case.
    }
  }
  return null;
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
  onProgress: (receivedBytes: number, totalBytes: number) => void,
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
  // A ~200 MB body arrives in tens of thousands of chunks; a few ticks a
  // second is all a progress label needs.
  let lastTick = 0;
  onProgress(0, declaredSize);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error("component archive is too large");
      }
      hash.update(value);
      if (Date.now() - lastTick >= 200) {
        lastTick = Date.now();
        onProgress(received, declaredSize);
      }
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
    onProgress(received, declaredSize);
  } finally {
    await handle.close();
  }
  const actualIntegrity = `sha512-${hash.digest("base64")}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error("component integrity verification failed");
  }
}

/**
 * What a turn waiting on `harness` hears while it gets ready: its first-use
 * downloads (the harness's and Bun's), a line a second at most, and then
 * that the harness is starting, which still takes a moment after a first
 * download. Returns the function that ends the watch.
 */
export function watchHarnessDownloads({
  store,
  harness,
  report,
  now = Date.now,
}: {
  store: Pick<HarnessComponentStore, "onProgress">;
  harness: DownloadableHarness;
  report: (activity: string) => void;
  now?: () => number;
}): (ready: boolean) => void {
  const downloads = new Map<DownloadableComponent, HarnessDownloadProgress>();
  let reported = { line: "", at: Number.NEGATIVE_INFINITY };
  const stop = store.onProgress((progress) => {
    if (progress.harness !== harness && progress.harness !== "bun") return;
    downloads.set(progress.harness, progress);
    // The harness first, then Bun, whichever started first.
    const line = harnessDownloadLine(
      [...downloads.values()].sort(
        (a, b) => Number(a.harness === "bun") - Number(b.harness === "bun"),
      ),
    );
    if (
      line === reported.line ||
      (now() - reported.at < 1000 && !line.startsWith("Setting up"))
    )
      return;
    reported = { line, at: now() };
    report(line);
  });
  return (ready) => {
    stop();
    if (ready && reported.line)
      report(`Starting ${componentDisplayName(harness)}`);
  };
}

/** What the person calls a harness or component. */
export function componentDisplayName(harness: DownloadableComponent): string {
  if (harness === "claude-code") return "Claude Code";
  return harness === "codex" ? "Codex" : "Bun";
}
