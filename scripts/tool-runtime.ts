import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const EXPECTED_NODE_VERSION = "v26.13.1";
const MAX_NODE_ARCHIVE_BYTES = 128 * 1024 * 1024;
// The official release's SHASUMS256.txt, reviewed with every runtime upgrade.
// https://nodejs.org/dist/v26.13.1/SHASUMS256.txt
const NODE_RELEASES = [
  {
    platform: "darwin",
    arch: "arm64",
    sha256: "af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559",
  },
  {
    platform: "darwin",
    arch: "x64",
    sha256: "2693310b2820f9350d29524f21344e1c623875bab773457d55b2aceb9670716f",
  },
  {
    platform: "linux",
    arch: "arm64",
    sha256: "89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd",
  },
  {
    platform: "linux",
    arch: "x64",
    sha256: "5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864",
  },
];

export function repositoryNodeRelease(input: {
  platform?: NodeJS.Platform;
  arch?: string;
}): { name: string; url: string; sha256: string } {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const release = NODE_RELEASES.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!release) {
    throw new Error(`Repository Node does not support ${platform}-${arch}`);
  }
  const name = `node-${EXPECTED_NODE_VERSION}-${platform}-${arch}`;
  return {
    name,
    url: `https://nodejs.org/dist/${EXPECTED_NODE_VERSION}/${name}.tar.xz`,
    sha256: release.sha256,
  };
}

export interface ToolRuntime {
  nodePath: string;
  env: NodeJS.ProcessEnv & { PATH: string };
}

/**
 * The checkout-local runtime installed by `bun install`. Tool launches only
 * resolve these verified bytes; they never fetch or select an ambient Node.
 */
export function repositoryNodePath(input: {
  rootPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const release = repositoryNodeRelease(input);
  return path.join(
    input.rootPath,
    "node_modules",
    ".cache",
    "catamorphic-node",
    release.name,
    "bin",
    "node",
  );
}

/** Download only during explicit installation, verify, then publish atomically. */
export async function installRepositoryNode(input: {
  rootPath: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<string> {
  const nodePath = repositoryNodePath(input);
  if (existsSync(nodePath)) {
    toolRuntime({ rootPath: input.rootPath, env: {} });
    return nodePath;
  }
  const release = repositoryNodeRelease({});
  const response = await (input.fetchImpl ?? fetch)(release.url, {
    signal: AbortSignal.timeout(5 * 60_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Node download failed: ${response.status} ${release.url}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_NODE_ARCHIVE_BYTES) {
    await response.body?.cancel();
    throw new Error("Node archive exceeds the download limit");
  }
  const archive = await response.arrayBuffer();
  if (archive.byteLength > MAX_NODE_ARCHIVE_BYTES) {
    throw new Error("Node archive exceeds the download limit");
  }
  const digest = createHash("sha256")
    .update(new Uint8Array(archive))
    .digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`Node archive SHA256 mismatch for ${release.name}`);
  }

  const directory = path.dirname(nodePath);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(path.join(directory, ".install-"));
  try {
    const archivePath = path.join(staging, "node.tar.xz");
    writeFileSync(archivePath, new Uint8Array(archive));
    execFileSync("tar", [
      "-xJf",
      archivePath,
      "-C",
      staging,
      `${release.name}/bin/node`,
    ]);
    const stagedNode = path.join(staging, release.name, "bin", "node");
    chmodSync(stagedNode, 0o755);
    const version = execFileSync(stagedNode, ["--version"], {
      encoding: "utf8",
    }).trim();
    if (version !== EXPECTED_NODE_VERSION) {
      throw new Error(
        `Expected repository Node ${EXPECTED_NODE_VERSION}, received ${version}`,
      );
    }
    renameSync(stagedNode, nodePath);
    return nodePath;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function toolRuntime(input: {
  rootPath: string;
  env: NodeJS.ProcessEnv;
}): ToolRuntime {
  const nodePath = repositoryNodePath({ rootPath: input.rootPath });
  if (!existsSync(nodePath)) {
    throw new Error(
      `Repository Node ${EXPECTED_NODE_VERSION} is not installed at ${nodePath}; run bun install`,
    );
  }
  const actualVersion = execFileSync(nodePath, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (actualVersion !== EXPECTED_NODE_VERSION) {
    throw new Error(
      `Expected repository Node ${EXPECTED_NODE_VERSION}, received ${actualVersion}`,
    );
  }

  const nodeBinDirectory = path.dirname(nodePath);
  const prefixedPath = input.env.PATH
    ? `${nodeBinDirectory}${path.delimiter}${input.env.PATH}`
    : nodeBinDirectory;

  return {
    nodePath,
    env: { ...input.env, PATH: prefixedPath },
  };
}

/** Keep shard flags on Vitest, so changing a shard never rebuilds dependencies. */
export function vitestShardArguments(shard: string | undefined): string[] {
  if (!shard) return [];
  const [index, total] = shard.split("/").map(Number);
  if (
    !/^[1-9]\d*\/[1-9]\d*$/.test(shard) ||
    !index ||
    !total ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index > total
  ) {
    throw new Error("CATAMORPHIC_TEST_SHARD must be index/total");
  }
  return [`--shard=${shard}`, "--passWithNoTests"];
}

if (import.meta.main) {
  const rootPath = path.resolve(import.meta.dirname, "..");
  const [tool, ...rawToolArguments] = process.argv.slice(2);
  if (tool === "install") {
    await installRepositoryNode({ rootPath });
    process.exit(0);
  }
  const runtime = toolRuntime({ rootPath, env: process.env });
  if (tool !== "vitest" && tool !== "turbo") {
    throw new Error(
      "Usage: bun scripts/tool-runtime.ts <install|vitest|turbo> [--tool-cwd <repository-relative-path>] [...arguments]",
    );
  }
  const cwdOptionIndex = rawToolArguments.indexOf("--tool-cwd");
  let workingDirectory = rootPath;
  let toolArguments = rawToolArguments;
  if (cwdOptionIndex !== -1) {
    const relativeWorkingDirectory = rawToolArguments[cwdOptionIndex + 1];
    if (!relativeWorkingDirectory) {
      throw new Error("--tool-cwd requires a repository-relative path");
    }
    workingDirectory = path.resolve(rootPath, relativeWorkingDirectory);
    if (
      workingDirectory !== rootPath &&
      !workingDirectory.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error("--tool-cwd must stay inside the repository");
    }
    toolArguments = rawToolArguments.filter(
      (_argument, index) =>
        index !== cwdOptionIndex && index !== cwdOptionIndex + 1,
    );
  }
  const entryPoint = path.join(
    rootPath,
    "node_modules",
    tool,
    tool === "vitest" ? "vitest.mjs" : path.join("bin", "turbo"),
  );
  const result = spawnSync(
    runtime.nodePath,
    [
      entryPoint,
      ...(tool === "vitest"
        ? ["run", ...vitestShardArguments(process.env.CATAMORPHIC_TEST_SHARD)]
        : []),
      ...toolArguments,
    ],
    {
      cwd: workingDirectory,
      env: runtime.env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}
