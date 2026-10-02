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
}

/** One tick of a first-use component download, for "Downloading… 42%" UI. */
export interface HarnessDownloadProgress {
  harness: DownloadableComponent;
  displayName: string;
  receivedBytes: number;
  /** 0 when the registry declared no content-length. */
  totalBytes: number;
}

interface PlatformRelease {
  rustTarget: string;
  claudeIntegrity: `sha512-${string}`;
  codexIntegrity: `sha512-${string}`;
  bunIntegrity: `sha512-${string}`;
}

const CLAUDE_VERSION = "0.3.287";
/**
 * The Claude Code CLI release the bundled Agent SDK ships with: an installed
 * Claude Code at this version or newer runs instead of Work's own copy
 * (ADR 0196). scripts/harness-bump.ts moves it with CLAUDE_VERSION.
 */
export const CLAUDE_CODE_MIN_VERSION = "2.1.287";
const CODEX_VERSION = "0.160.0";
const BUN_VERSION = "1.3.14";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

const PLATFORM_RELEASES: Record<string, PlatformRelease> = {
  "darwin-arm64": {
    rustTarget: "aarch64-apple-darwin",
    claudeIntegrity:
      "sha512-Ic9GCrPBmMroLi7q+IeQQdtVDQLOaaSxkH1NzPsSRZxSvFcMH6M7zz/LahzlLQTdDyebcyMLk4aBXl4H8NnbFw==",
    codexIntegrity:
      "sha512-aefV6cqZA2REZgR//4McyXlp7zLcTti4CI2v3j9IVgNndPBv2kCeNEcz07qeelXcwOdSFPUKb6roA48vZmDgrQ==",
    bunIntegrity:
      "sha512-Omj20SuiHBOUjUBIyqtkNjSUIjOtEOJwmbix/ZyFH4BaQ6OZTaaRWIR4TjHVz0yadHgli6lLTiAh1uarnvD49A==",
  },
  "darwin-x64": {
    rustTarget: "x86_64-apple-darwin",
    claudeIntegrity:
      "sha512-7BxpyKMkzLQxCdq4OEnrjtLRC3O69l0LSBZYyUPXPTCFTnvzqpELjPRUssyW9auKEtVoh8eTySwC2rwGzuMUqA==",
    codexIntegrity:
      "sha512-ir7cdsPrb9VkqNqpTECoTiomv04xws/FQ968mHQzuL+2J5Da0Dkh2Qlxp7sguDDZJab4YpYmNjQvBVMXbTeQaQ==",
    bunIntegrity:
      "sha512-FFj3QdU/OhlDyZOJ8CWfN5eWLpRlT4qjZg7lMQi7jA6GuoY5ajlO1zWLP/MuHYRSbXQUvV52RejNi8DVnAp13w==",
  },
  "linux-arm64": {
    rustTarget: "aarch64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-CWqO5p3YSBmpi/qHywul0re6fjljbDMZVj45PouNb1Qqws2Wi2h/Wp/ojOnfQAmq4m29pV2qgDnN2UtjaOobKA==",
    codexIntegrity:
      "sha512-VnVdsS06YlDsL8OwaJjQ3xdqdJNG4i+eBJBV3LytddknzSaF/urijLzVg3ptkwvoj8C7Gn7iWpVE+y8WEaPiCg==",
    bunIntegrity:
      "sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==",
  },
  "linux-x64": {
    rustTarget: "x86_64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-/6Zw5nym4xfc2eFGaIrS7dt7JoBgASsGUnLWMoPV4M1hGH0tOSPzpixfb4OWO6r9iw9Nn/Zk5Ke1KRuMuja2+Q==",
    codexIntegrity:
      "sha512-KI/73OqGrHmR18s7ya7E1NqV6rT0y3lxr0s8S1qR2m6zU6QRF/HlR529jALLh5vjdUnsRT4Ahoxt0axb4kY99g==",
    bunIntegrity:
      "sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==",
  },
  "win32-arm64": {
    rustTarget: "aarch64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-6AdDoLnnVG9aRrWoGVQjS3i4+hceCGFEHVPkMBzbVFs76G1WKlY/ZMnELu3X+ZE5QJFT3j4qqmdJ0y+QbrycEg==",
    codexIntegrity:
      "sha512-tTvK9ZIGuj9WnYaYOAnfjJVSfPV7dKqWtDHqUPLf0Hadp6SgynTxx7S7iMXRieFeXVOI2XH76KxEHSOTOnz3zw==",
    bunIntegrity:
      "sha512-T7s3x/BsVKQObGU6QDkZeI6wKynzqGbBH1yI77jrrj5siElclxr3DQrDIk8CV4G5/SJq2HHq4kpLyYY2DKCSmA==",
  },
  "win32-x64": {
    rustTarget: "x86_64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-fczDcWG2Hu+nYQgxeQEsGn5l+3M06RpJXysIsu/BmHTPl7UceTfTpSYr6O/9GU/sNhU0CADJaIIZNwQTfK0DWw==",
    codexIntegrity:
      "sha512-/gCFcuOmGlQkgGivWCtY8BNEDixh70Pue0HZOk9S8bj2vUIE1GLD9zcNB/KqqDJmn0S+lIttauLpzQnw6HOCHA==",
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
        `${displayName(harness)} is unavailable on ${process.platform}-${process.arch}.`,
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
    try {
      const response = await this.fetchImpl(artifact.tarballUrl, {
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        throw new Error(`download returned HTTP ${response.status}`);
      }
      await writeVerifiedArchive(
        response,
        archive,
        artifact.integrity,
        (receivedBytes, totalBytes) => {
          for (const listener of this.progressListeners) {
            listener({
              harness,
              displayName: artifact.displayName,
              receivedBytes,
              totalBytes,
            });
          }
        },
      );
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

function displayName(harness: DownloadableComponent): string {
  if (harness === "claude-code") return "Claude Code";
  return harness === "codex" ? "Codex" : "Bun";
}
