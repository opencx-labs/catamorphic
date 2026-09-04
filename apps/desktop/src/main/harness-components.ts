import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export type DownloadableHarness = "claude-code" | "codex";

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
  artifacts?: Partial<Record<DownloadableHarness, HarnessArtifact>>;
  fetchImpl?: typeof fetch;
  preferInstalled?: boolean;
}

interface PlatformRelease {
  rustTarget: string;
  claudeIntegrity: `sha512-${string}`;
  codexIntegrity: `sha512-${string}`;
}

const CLAUDE_VERSION = "0.3.226";
const CODEX_VERSION = "0.144.6";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

const PLATFORM_RELEASES: Record<string, PlatformRelease> = {
  "darwin-arm64": {
    rustTarget: "aarch64-apple-darwin",
    claudeIntegrity:
      "sha512-ycyuSgN2XaSYdze1eM2wDwNmXS5wPqIh1RxiDs99ywPr9lpe3Y/Xcv0nz9JN5ahNoPIgWHIfI9Ac1EWCOdIF1Q==",
    codexIntegrity:
      "sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==",
  },
  "darwin-x64": {
    rustTarget: "x86_64-apple-darwin",
    claudeIntegrity:
      "sha512-sOOCkhtMDGVKs6k3fpTAkCML974qOnt8Bm9zlC6rV0HkM0aP4bdDY1RAlKLF4fHmOP2s5fPTY3myZiHGDFnuUg==",
    codexIntegrity:
      "sha512-THRyPG0zSU6M8NQAge1LHEHsJDnoH4BpKsfJHB/qe3Fm+Wf6zqAmWJFlOKzBm27m0K2Hq3za4Ac2I5p5i4yp/A==",
  },
  "linux-arm64": {
    rustTarget: "aarch64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-YNwwC37m2vcY47mWZGqRmDh2ZSrO0Z01iTlIDsPmvKv03+7pwyaXVuq01Evtyp7see+KGeIYkMN37HhEt/h+8Q==",
    codexIntegrity:
      "sha512-PGiLXMN+2IQRkf7tOLi64dMInjU1pRLbz0Rwfj/yt2Y97SZQqAjFQoi2wmswmqtqMDnfwCPTC1DRXVQkvU6T6Q==",
  },
  "linux-x64": {
    rustTarget: "x86_64-unknown-linux-musl",
    claudeIntegrity:
      "sha512-gPoHNeko9E+bmKVPRiAcCAOyBBrVcIH/WdjmyaGVoTP2bKibTs978A42rMNtAnuPBcAGAiImQimUU7w1TXESFw==",
    codexIntegrity:
      "sha512-4E7EnzCg0OnBxCyYnwJ+qnZwWHYe0YScr5ucKWbngE9u4+0XrpWELqq2Kn9jl5GZK8MDjU7PrJwFIwusHOHjuw==",
  },
  "win32-arm64": {
    rustTarget: "aarch64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-qkzWTR3Ns8PimC5rx4+cwfuyHlCRocGIAcdWDUgpnI70qH5GlqX9R0VfM7wGOCs/C+fJ04Hg0GfAkMv4xriZwA==",
    codexIntegrity:
      "sha512-SpMjXJLW43JzMP0K62mVcYfmFcpk0BK4AOgYmWSfyZHs3iRtHMd0UYw7605n/9lwkT2EqbwQLT2omZFeKJFzwA==",
  },
  "win32-x64": {
    rustTarget: "x86_64-pc-windows-msvc",
    claudeIntegrity:
      "sha512-uxVbLwGSX6lvO5Tazv0gZu8WSg1o14DQsqGSY+5pDNUk28KmNbFIQAjky9KeDzk9lnf63/aQPPsaq6UAikWjqA==",
    codexIntegrity:
      "sha512-dN39VnjEthKz5io1RNWwZDtErdSn07nW3pGUgvlA6DMxgm/nuGaIAZO/sG/Hgxq/x5j9HteAENfrFgVkpZ0lFg==",
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
    Record<DownloadableHarness, HarnessArtifact>
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly preferInstalled: boolean;
  private readonly pending = new Map<
    DownloadableHarness,
    Promise<HarnessExecutable>
  >();

  constructor(options: HarnessComponentStoreOptions) {
    this.rootDir = options.rootDir;
    this.artifacts = options.artifacts ?? platformArtifacts();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.preferInstalled = options.preferInstalled ?? true;
  }

  async ensure(harness: DownloadableHarness): Promise<HarnessExecutable> {
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
    harness: DownloadableHarness,
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
    harness: DownloadableHarness,
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
    harness: DownloadableHarness,
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
  Record<DownloadableHarness, HarnessArtifact>
> {
  const target = `${process.platform}-${process.arch}`;
  const release = PLATFORM_RELEASES[target];
  if (!release) return {};
  const executable = process.platform === "win32" ? ".exe" : "";
  const claudePackage = `@anthropic-ai/claude-agent-sdk-${target}`;
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

function displayName(harness: DownloadableHarness): string {
  return harness === "claude-code" ? "Claude Code" : "Codex";
}
