// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: The publishing CLI runs directly, outside Turbo's cached tasks.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopReleaseKind, verifyDesktopRelease } from "./desktop-release.js";
import { toolRuntime } from "./tool-runtime.js";

export const NPM_REGISTRY = "https://registry.npmjs.org";
const REPOSITORY = "git+https://github.com/opencx-labs/catamorphic.git";
const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  license?: string;
  publishConfig?: { registry?: string; access?: string };
  repository?: { type?: string; url?: string; directory?: string };
}

export interface WorkspacePackage {
  directory: string;
  manifest: Manifest;
}

export interface PackageArtifact {
  name: string;
  version: string;
  filename: string;
  integrity: string;
}

interface Inventory {
  version: string;
  packages: PackageArtifact[];
}

export interface RegistryPackage {
  versions?: Record<string, { dist?: { integrity?: string } }>;
  "dist-tags"?: Record<string, string>;
}

function readManifest(filename: string): Manifest {
  const manifest: Manifest = JSON.parse(readFileSync(filename, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string")
    throw new Error(`${filename} must name a versioned workspace package`);
  return manifest;
}

export function workspacePackages(rootPath: string): WorkspacePackage[] {
  return ["packages", "apps"].flatMap((parent) =>
    readdirSync(path.join(rootPath, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const directory = path.join(rootPath, parent, entry.name);
        const filename = path.join(directory, "package.json");
        return existsSync(filename)
          ? [{ directory, manifest: readManifest(filename) }]
          : [];
      }),
  );
}

export function npmReleaseTag(version: string): "alpha" | "latest" {
  return desktopReleaseKind(version) === "preview" ? "alpha" : "latest";
}

/** One version, including private apps; no commits or tags are created. */
export function setReleaseVersion(input: {
  rootPath: string;
  version: string;
}) {
  desktopReleaseKind(input.version);
  for (const workspace of workspacePackages(input.rootPath)) {
    const filename = path.join(workspace.directory, "package.json");
    writeFileSync(
      filename,
      `${JSON.stringify({ ...workspace.manifest, version: input.version }, null, 2)}\n`,
    );
  }
}

/** Runtime edges determine publication order. Development edges may cycle. */
export function publicationOrder(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const ordered: WorkspacePackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pkg: WorkspacePackage) => {
    const name = pkg.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name))
      throw new Error(`Runtime dependency cycle at ${name}`);
    visiting.add(name);
    for (const section of dependencySections) {
      for (const dependency of Object.keys(pkg.manifest[section] ?? {})) {
        const target = byName.get(dependency);
        if (target) visit(target);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(pkg);
  };
  for (const pkg of packages) visit(pkg);
  return ordered;
}

export function verifyReleasePackages(input: {
  rootPath: string;
  version?: string;
}): { version: string; packages: WorkspacePackage[] } {
  const version = readManifest(
    path.join(input.rootPath, "apps/desktop/package.json"),
  ).version;
  verifyDesktopRelease({
    tag: `desktop-v${input.version ?? version}`,
    packageVersion: version,
  });
  const workspaces = workspacePackages(input.rootPath);
  const publicPackages = workspaces.filter((pkg) => !pkg.manifest.private);
  const publicNames = new Set(publicPackages.map((pkg) => pkg.manifest.name));
  for (const { manifest, directory } of workspaces) {
    if (manifest.version !== version)
      throw new Error(
        `${manifest.name} is ${manifest.version}, expected ${version}`,
      );
    // The Cloudflare bridge is a deployed Worker, not an importable library.
    if (manifest.private) {
      if (manifest.exports)
        throw new Error(`${manifest.name} exports a library but is private`);
      continue;
    }
    if (!directory.startsWith(path.join(input.rootPath, "packages") + path.sep))
      throw new Error(`${manifest.name}: applications must remain private`);
    if (
      !manifest.name.startsWith("@catamorphic/") ||
      manifest.license !== "Apache-2.0" ||
      manifest.publishConfig?.registry !== NPM_REGISTRY ||
      manifest.publishConfig.access !== "public" ||
      manifest.repository?.url !== REPOSITORY
    )
      throw new Error(`${manifest.name}: missing public npm release metadata`);
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (name.startsWith("@catamorphic/")) {
          if (!publicNames.has(name))
            throw new Error(`${manifest.name} depends on unpublished ${name}`);
          if (range !== "workspace:*" && range !== version)
            throw new Error(`${manifest.name}: ${name} must use workspace:*`);
        } else if (/^(file:|link:|workspace:)/.test(range)) {
          throw new Error(`${manifest.name}: ${name} uses a local dependency`);
        }
      }
    }
  }
  if (publicPackages.length === 0) throw new Error("No public libraries found");
  return { version, packages: publicationOrder(publicPackages) };
}

function exportedFiles(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportedFiles);
}

function isPublicReplayAsset(name: string, file: string): boolean {
  return (
    (name === "@catamorphic/codex" &&
      /^fixtures\/replay\/[^/]+\.json$/.test(file)) ||
    (name === "@catamorphic/claude-code" &&
      /^src\/testing\/fixtures\/[^/]+\.json$/.test(file))
  );
}

/** Inspect the actual archive, including Bun source exports and runtime assets. */
export function verifyPackedPackage(input: {
  manifest: Manifest;
  files: string[];
  expected: { name: string; version: string };
}) {
  const { manifest, files, expected } = input;
  if (manifest.name !== expected.name || manifest.version !== expected.version)
    throw new Error(
      `Archive identity differs from ${expected.name}@${expected.version}`,
    );
  if (manifest.private) throw new Error(`${manifest.name}: archive is private`);
  for (const file of files) {
    if (
      /(^|\/)(?:__tests__|__fixtures__|node_modules|\.git)(\/|$)/.test(file) ||
      (/(^|\/)fixtures(\/|$)/.test(file) &&
        !isPublicReplayAsset(manifest.name, file)) ||
      /\.(?:test|spec)\.[^/]+$/.test(file) ||
      /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.dev\.vars(?:\..*)?)$/.test(file) ||
      /\.(?:pem|key|p12|pfx)$/.test(file)
    )
      throw new Error(`${manifest.name}: unexpected archive file ${file}`);
  }
  for (const entry of [
    ...exportedFiles(manifest.exports),
    ...(manifest.main ? [manifest.main] : []),
    ...(manifest.types ? [manifest.types] : []),
    ...Object.values(manifest.bin ?? {}),
  ]) {
    const target = entry.replace(/^\.\//, "");
    if (
      !files.some(
        (file) =>
          path.matchesGlob(file, target) || file.startsWith(`${target}/`),
      )
    )
      throw new Error(`${manifest.name}: exported file ${entry} is absent`);
  }
  for (const section of [...dependencySections, "devDependencies"] as const) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (/^(workspace:|file:|link:)/.test(range))
        throw new Error(`${manifest.name}: packed ${name} still uses ${range}`);
      if (name.startsWith("@catamorphic/") && range !== expected.version)
        throw new Error(
          `${manifest.name}: packed ${name} must equal ${expected.version}`,
        );
    }
  }
  if (
    manifest.name === "@catamorphic/db" &&
    !files.some((file) => /^migrations\/.+\.sql$/.test(file))
  )
    throw new Error("Database migrations are absent from the archive");
  if (
    manifest.name === "@catamorphic/runner-bundle" &&
    !files.includes("dist/runner.mjs")
  )
    throw new Error("The sandbox runner is absent from the archive");
  if (!files.some((file) => /^LICENSE(?:\.txt)?$/.test(file)))
    throw new Error(`${manifest.name}: the license is absent from the archive`);
}

function integrity(filename: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(filename)).digest("base64")}`;
}

function inspectArchive(
  filename: string,
  expected: { name: string; version: string },
) {
  const manifest: Manifest = JSON.parse(
    execFileSync("tar", ["-xOf", filename, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  const files = execFileSync("tar", ["-tzf", filename], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((file) => file.replace(/^package\//, ""))
    .filter((file) => !file.endsWith("/"));
  verifyPackedPackage({ manifest, files, expected });
}

export function packReleasePackages(input: {
  rootPath: string;
  outputPath: string;
}) {
  const release = verifyReleasePackages(input);
  mkdirSync(input.outputPath, { recursive: true });
  const packages = release.packages.map(({ manifest, directory }) => {
    const filename = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${release.version}.tgz`;
    const archive = path.join(input.outputPath, filename);
    const copiedNotices: string[] = [];
    try {
      for (const name of ["LICENSE", "NOTICE"]) {
        const destination = path.join(directory, `${name}.txt`);
        if (existsSync(destination)) continue;
        copyFileSync(path.join(input.rootPath, name), destination);
        copiedNotices.push(destination);
      }
      execFileSync(
        "bun",
        ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive],
        { cwd: directory, stdio: "pipe" },
      );
    } finally {
      for (const filename of copiedNotices) rmSync(filename, { force: true });
    }
    inspectArchive(archive, manifest);
    console.log(`Packed ${manifest.name}@${release.version}`);
    return {
      name: manifest.name,
      version: release.version,
      filename,
      integrity: integrity(archive),
    };
  });
  const inventory: Inventory = { version: release.version, packages };
  writeFileSync(
    path.join(input.outputPath, "packages.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return inventory;
}

function readInventory(directory: string): Inventory {
  const inventory: Inventory = JSON.parse(
    readFileSync(path.join(directory, "packages.json"), "utf8"),
  );
  desktopReleaseKind(inventory.version);
  if (!Array.isArray(inventory.packages) || inventory.packages.length === 0)
    throw new Error("The release inventory is empty");
  for (const pkg of inventory.packages) {
    if (
      path.basename(pkg.filename) !== pkg.filename ||
      pkg.version !== inventory.version
    )
      throw new Error(`Invalid release artifact ${pkg.name}`);
    const archive = path.join(directory, pkg.filename);
    if (integrity(archive) !== pkg.integrity)
      throw new Error(`Artifact integrity differs for ${pkg.name}`);
    inspectArchive(archive, pkg);
  }
  return inventory;
}

/** A separate consumer has no workspace links, root overrides or dev dependencies. */
export function smokeReleasePackages(input: {
  rootPath: string;
  directory: string;
}) {
  const inventory = readInventory(input.directory);
  const consumer = mkdtempSync(
    path.join(tmpdir(), "catamorphic-npm-consumer-"),
  );
  const runtime = toolRuntime({ rootPath: input.rootPath, env: process.env });
  const install = () => {
    execFileSync(
      runtime.nodePath,
      [
        path.join(input.rootPath, "node_modules/npm/bin/npm-cli.js"),
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      { cwd: consumer, env: runtime.env, stdio: "inherit" },
    );
  };
  // Exercise optional entry points with the host peers they explicitly declare.
  const peers = inventory.packages.flatMap((pkg) => {
    const manifest: Manifest = JSON.parse(
      execFileSync(
        "tar",
        [
          "-xOf",
          path.join(input.directory, pkg.filename),
          "package/package.json",
        ],
        { encoding: "utf8" },
      ),
    );
    return Object.entries(manifest.peerDependencies ?? {});
  });
  try {
    writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        devDependencies: {
          "@types/node": "^24",
          "@types/react": "^19.2.17",
        },
        dependencies: Object.fromEntries([
          ...peers,
          ...inventory.packages.map((pkg) => [
            pkg.name,
            `file:${path.join(input.directory, pkg.filename)}`,
          ]),
        ]),
      }),
    );
    install();
    const entries = inventory.packages.flatMap((pkg) => {
      const manifest = readManifest(
        path.join(consumer, "node_modules", pkg.name, "package.json"),
      );
      if (!manifest.exports || typeof manifest.exports !== "object") return [];
      return Object.entries(manifest.exports)
        .filter(
          ([key, value]) =>
            (key === "." || key.startsWith("./")) &&
            typeof value === "object" &&
            value !== null,
        )
        .map(([key]) => `${pkg.name}${key === "." ? "" : key.slice(1)}`);
    });
    const program =
      entries
        .map((entry) => `await import(${JSON.stringify(entry)});`)
        .join("\n") +
      `
const { loadCodexFixture, CODEX_REPLAY_FIXTURES } = await import("@catamorphic/codex/testing");
for (const scenario of CODEX_REPLAY_FIXTURES) await loadCodexFixture(scenario);
const { loadClaudeTranscript } = await import("@catamorphic/claude-code/testing");
await loadClaudeTranscript({ scenario: "simple-reply", tokens: { cwd: "/consumer", state: "/state", home: "/home", model: "test" } });
`;
    writeFileSync(path.join(consumer, "smoke.mjs"), program);
    for (const executable of [runtime.nodePath, "bun"])
      execFileSync(executable, ["smoke.mjs"], {
        cwd: consumer,
        env: runtime.env,
        stdio: "inherit",
      });
    writeFileSync(
      path.join(consumer, "server.mjs"),
      `
import { createWorkServer, workServerConfigFromEnv } from "@catamorphic/work-server";
import path from "node:path";
const server = await createWorkServer({ config: workServerConfigFromEnv({
  WORK_DATA_DIR: path.resolve("server-data"), WORK_FAKE_AGENT: "1", WORK_MDNS: "off",
}) });
try {
  const response = await server.app.inject({ method: "GET", url: "/healthz" });
  if (response.statusCode !== 200 || response.json().ok !== true) throw new Error("Fresh server failed its health check");
} finally { await server.shutdown(); }
`,
    );
    execFileSync("bun", ["server.mjs"], {
      cwd: consumer,
      env: runtime.env,
      stdio: "inherit",
    });
    writeFileSync(
      path.join(consumer, "smoke.ts"),
      entries
        .map(
          (entry, index) =>
            `import * as package${index} from ${JSON.stringify(entry)};`,
        )
        .join("\n"),
    );
    execFileSync(
      runtime.nodePath,
      [
        path.join(input.rootPath, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "smoke.ts",
      ],
      { cwd: consumer, env: runtime.env, stdio: "inherit" },
    );
    const tarballs = Object.fromEntries(
      inventory.packages.map((pkg) => [
        pkg.name,
        `file:${path.join(input.directory, pkg.filename)}`,
      ]),
    );
    for (const name of [
      "@catamorphic/server-sdk",
      "@catamorphic/work-server",
    ]) {
      // Only this library is a root dependency; the others must be declared
      // transitively. Overrides stand in for the not-yet-published registry.
      rmSync(path.join(consumer, "node_modules"), {
        recursive: true,
        force: true,
      });
      writeFileSync(
        path.join(consumer, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          devDependencies: {
            "@types/node": "^24",
          },
          dependencies: { [name]: tarballs[name] },
          overrides: tarballs,
        }),
      );
      install();
      writeFileSync(
        path.join(consumer, "isolated.mjs"),
        `await import(${JSON.stringify(name)});`,
      );
      for (const executable of [runtime.nodePath, "bun"])
        execFileSync(executable, ["isolated.mjs"], {
          cwd: consumer,
          env: runtime.env,
          stdio: "inherit",
        });
      writeFileSync(
        path.join(consumer, "isolated.ts"),
        `import * as library from ${JSON.stringify(name)};`,
      );
      execFileSync(
        runtime.nodePath,
        [
          path.join(input.rootPath, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          "isolated.ts",
        ],
        { cwd: consumer, env: runtime.env, stdio: "inherit" },
      );
      if (name === "@catamorphic/work-server") {
        rmSync(path.join(consumer, "server-data"), {
          recursive: true,
          force: true,
        });
        execFileSync("bun", ["server.mjs"], {
          cwd: consumer,
          env: runtime.env,
          stdio: "inherit",
        });
      }
    }
    console.log(
      `Verified ${inventory.packages.length} npm tarballs with Node, Bun, and TypeScript, plus standalone SDK and server installs`,
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

export async function registeredPackage(
  name: string,
): Promise<RegistryPackage> {
  // Match npm's canonical scoped path and fresh metadata reads. Cached
  // install metadata can hide a just-published version for five minutes.
  const response = await fetch(
    `${NPM_REGISTRY}/${name.replace("/", "%2f")}?write=true`,
  );
  if (response.status === 404) return {};
  if (!response.ok)
    throw new Error(`npm lookup for ${name} failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isRegistryPackage(value))
    throw new Error(`npm returned invalid package metadata for ${name}`);
  return value;
}

function isRegistryPackage(value: unknown): value is RegistryPackage {
  if (!value || typeof value !== "object") return false;
  if (
    !("versions" in value) ||
    !value.versions ||
    typeof value.versions !== "object"
  )
    return false;
  return Object.values(value.versions).every((version: unknown) => {
    if (!version || typeof version !== "object" || !("dist" in version))
      return false;
    const dist = version.dist;
    return (
      !!dist &&
      typeof dist === "object" &&
      "integrity" in dist &&
      typeof dist.integrity === "string"
    );
  });
}

/** Preflight every version before any write. A retry must never overwrite history. */
function compareReleaseVersions(input: {
  left: string;
  right: string;
}): number {
  const { left, right } = input;
  const leftKind = desktopReleaseKind(left);
  const rightKind = desktopReleaseKind(right);
  const leftCore = left.split("-")[0]?.split(".") ?? [];
  const rightCore = right.split("-")[0]?.split(".") ?? [];
  for (const index of [0, 1, 2]) {
    const a = BigInt(leftCore[index] ?? "0");
    const b = BigInt(rightCore[index] ?? "0");
    if (a !== b) return a > b ? 1 : -1;
  }
  if (leftKind !== rightKind) return leftKind === "stable" ? 1 : -1;
  if (leftKind === "stable") return 0;
  const a = BigInt(left.slice(left.lastIndexOf(".") + 1));
  const b = BigInt(right.slice(right.lastIndexOf(".") + 1));
  return a === b ? 0 : a > b ? 1 : -1;
}

export function publicationPlan(input: {
  packages: PackageArtifact[];
  registered: RegistryPackage[];
}): PackageArtifact[] {
  return input.packages.filter((pkg, index) => {
    const registered = input.registered[index];
    if (!registered) throw new Error(`Missing npm lookup for ${pkg.name}`);
    for (const channel of ["alpha", "latest"]) {
      const current = registered["dist-tags"]?.[channel];
      if (
        current &&
        current !== "0.0.0-stage" &&
        compareReleaseVersions({ left: current, right: pkg.version }) > 0
      )
        throw new Error(
          `${pkg.name}: refusing to move ${channel} backward from ${current} to ${pkg.version}`,
        );
    }
    const existing = registered.versions?.[pkg.version];
    if (!existing) return true;
    if (existing.dist?.integrity !== pkg.integrity)
      throw new Error(
        `${pkg.name}@${pkg.version} exists with different content; release a new version`,
      );
    return false;
  });
}

/** npm can promote the first real version when replacing its staging placeholder. */
export function bootstrapLatestRemovals(input: {
  packages: PackageArtifact[];
  registered: RegistryPackage[];
}): PackageArtifact[] {
  if (publicationPlan(input).length)
    throw new Error(
      "Channel repair requires every exact version to be published",
    );
  return input.packages.filter((pkg, index) => {
    if (npmReleaseTag(pkg.version) !== "alpha") return false;
    const registered = input.registered[index];
    if (registered?.["dist-tags"]?.alpha !== pkg.version)
      throw new Error(`${pkg.name}: unexpected alpha channel during repair`);
    if (registered["dist-tags"]?.latest !== pkg.version) return false;
    if (
      Object.keys(registered.versions ?? {}).some((version) =>
        /^\d+\.\d+\.\d+$/.test(version),
      )
    )
      throw new Error(`${pkg.name}: cannot infer the previous stable latest`);
    return true;
  });
}

async function reconcileBootstrapChannels(inventory: Inventory) {
  const registered = await Promise.all(
    inventory.packages.map((pkg) => registeredPackage(pkg.name)),
  );
  // Validate the complete release before the first metadata mutation.
  const removals = bootstrapLatestRemovals({
    packages: inventory.packages,
    registered,
  });
  for (const pkg of removals) {
    // Recheck immediately before removing only this release's accidental tag.
    const fresh = await registeredPackage(pkg.name);
    if (
      !bootstrapLatestRemovals({ packages: [pkg], registered: [fresh] }).length
    )
      continue;
    const result = spawnSync(
      "npm",
      [
        "dist-tag",
        "rm",
        pkg.name,
        "latest",
        "--registry",
        NPM_REGISTRY,
        `--@catamorphic:registry=${NPM_REGISTRY}`,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `${pkg.name}: channel repair failed; trusted publishing also needs Allow npm dist-tag`,
      );
  }
}

export interface NpmRepairRun {
  id: number;
  event: string;
  path: string;
  head_branch: string;
  head_sha: string;
  status: string;
  repository: { full_name: string };
}

export function verifyNpmRepairRun(input: {
  run: NpmRepairRun;
  runId: string;
  version: string;
  tagCommit: string;
  jobs: { jobs: { name: string; conclusion: string | null }[] };
}) {
  const { run, runId, version, tagCommit, jobs } = input;
  desktopReleaseKind(version);
  if (
    !/^[1-9]\d*$/.test(runId) ||
    String(run.id) !== runId ||
    run.repository.full_name !== "opencx-labs/catamorphic" ||
    run.event !== "push" ||
    run.path !== ".github/workflows/desktop-prerelease.yml" ||
    run.head_branch !== `desktop-v${version}` ||
    !/^[a-f0-9]{40}$/.test(tagCommit) ||
    run.head_sha !== tagCommit ||
    run.status !== "completed"
  )
    throw new Error("Repair source does not match the immutable release tag");
  for (const name of [
    "Build and verify npm packages",
    "Build, sign, and notarize macOS",
  ])
    if (
      !jobs.jobs.some(
        (job) => job.name === name && job.conclusion === "success",
      )
    )
      throw new Error(`Repair requires successful original job: ${name}`);
}

/** Read committed metadata only; never execute scripts from an old release. */
export function releasePackageNamesAtCommit(input: {
  rootPath: string;
  commit: string;
  version: string;
}): string[] {
  if (!/^[a-f0-9]{40}$/.test(input.commit))
    throw new Error("Release inventory requires an exact commit");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: input.rootPath, encoding: "utf8" });
  const filenames = git([
    "ls-tree",
    "-r",
    "--name-only",
    input.commit,
    "--",
    "packages",
    "apps",
  ])
    .trim()
    .split("\n")
    .filter((filename) =>
      /^(packages|apps)\/[^/]+\/package\.json$/.test(filename),
    );
  const manifests: Manifest[] = filenames.map((filename) =>
    JSON.parse(git(["show", `${input.commit}:${filename}`])),
  );
  if (
    !manifests.length ||
    manifests.some((manifest) => manifest.version !== input.version)
  )
    throw new Error("Original workspace versions do not match the release");
  return manifests
    .filter((manifest) => !manifest.private)
    .map((manifest) => manifest.name)
    .sort();
}

async function repairBootstrapRelease(input: {
  rootPath: string;
  directory: string;
  runId: string;
}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !/^[1-9]\d*$/.test(input.runId)
  )
    throw new Error(
      "Channel repair must run explicitly from main on GitHub Actions",
    );
  const gh = (args: string[]) =>
    execFileSync("gh", args, { cwd: input.rootPath, encoding: "utf8" });
  const run: NpmRepairRun = JSON.parse(
    gh(["api", `repos/opencx-labs/catamorphic/actions/runs/${input.runId}`]),
  );
  const jobPages: { jobs: { name: string; conclusion: string | null }[] }[] =
    JSON.parse(
      gh([
        "api",
        `repos/opencx-labs/catamorphic/actions/runs/${input.runId}/jobs?filter=all&per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    );
  const jobs = { jobs: jobPages.flatMap((page) => page.jobs) };
  const tag = run.head_branch;
  const version = tag.replace(/^desktop-v/, "");
  verifyDesktopRelease({ tag, packageVersion: version });
  if (npmReleaseTag(version) !== "alpha")
    throw new Error("Bootstrap channel repair is only for a Preview release");
  execFileSync(
    "git",
    ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    {
      cwd: input.rootPath,
      stdio: "inherit",
    },
  );
  const tagCommit = execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
    cwd: input.rootPath,
    encoding: "utf8",
  }).trim();
  verifyNpmRepairRun({
    run,
    runId: input.runId,
    version,
    tagCommit,
    jobs,
  });
  const artifacts: {
    artifacts: { id: number; name: string; expired: boolean }[];
  } = JSON.parse(
    gh([
      "api",
      `repos/opencx-labs/catamorphic/actions/runs/${input.runId}/artifacts?per_page=100`,
    ]),
  );
  const matches = artifacts.artifacts.filter(
    (artifact) =>
      artifact.name === `npm-packages-${version}` && !artifact.expired,
  );
  if (matches.length !== 1)
    throw new Error(
      "The original retained npm artifact must exist exactly once",
    );
  // Download only the original run's retained archives; never repack or publish.
  gh([
    "run",
    "download",
    input.runId,
    "--repo",
    "opencx-labs/catamorphic",
    "--name",
    `npm-packages-${version}`,
    "--dir",
    input.directory,
  ]);
  const inventory = readInventory(input.directory);
  const expectedNames = releasePackageNamesAtCommit({
    rootPath: input.rootPath,
    commit: tagCommit,
    version,
  });
  if (
    inventory.version !== version ||
    inventory.packages
      .map((pkg) => pkg.name)
      .sort()
      .join("\n") !== expectedNames.join("\n")
  )
    throw new Error(
      "The original artifact does not contain this complete release",
    );
  await reconcileBootstrapChannels(inventory);
  await verifyPublishedRelease(inventory);
}

async function preflightReleasePackages(input: {
  rootPath: string;
  directory: string;
}) {
  const { directory } = input;
  const inventory = readInventory(directory);
  const release = verifyReleasePackages({
    rootPath: input.rootPath,
    version: inventory.version,
  });
  const expectedNames = release.packages.map((pkg) => pkg.manifest.name).sort();
  const actualNames = inventory.packages.map((pkg) => pkg.name).sort();
  if (expectedNames.join("\n") !== actualNames.join("\n"))
    throw new Error("The inventory must contain every library exactly once");
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (process.env.GITHUB_EVENT_NAME !== "push" ||
      process.env.GITHUB_REF !== `refs/tags/desktop-v${inventory.version}`)
  )
    throw new Error(
      "Only the matching release tag may publish from GitHub Actions",
    );
  const registered = await Promise.all(
    inventory.packages.map((pkg) => registeredPackage(pkg.name)),
  );
  const pending = publicationPlan({ packages: inventory.packages, registered });
  return { inventory, pending };
}

async function publishReleasePackages(input: {
  rootPath: string;
  directory: string;
}) {
  const { directory } = input;
  const { inventory, pending } = await preflightReleasePackages(input);
  for (const pkg of pending) {
    const result = spawnSync(
      "npm",
      [
        "publish",
        path.join(directory, pkg.filename),
        "--ignore-scripts",
        "--access",
        "public",
        "--tag",
        npmReleaseTag(inventory.version),
        "--registry",
        NPM_REGISTRY,
        `--@catamorphic:registry=${NPM_REGISTRY}`,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `npm publication failed for ${pkg.name}; preserve already published versions and rerun this release`,
      );
  }
  await reconcileBootstrapChannels(inventory);
  await verifyPublishedRelease(inventory);
}

async function verifyPublishedRelease(inventory: Inventory) {
  for (const pkg of inventory.packages) {
    const registered = await registeredPackage(pkg.name);
    if (registered.versions?.[pkg.version]?.dist?.integrity !== pkg.integrity)
      throw new Error(`npm did not confirm ${pkg.name}@${pkg.version}`);
    if (
      registered["dist-tags"]?.[npmReleaseTag(inventory.version)] !==
      inventory.version
    )
      throw new Error(
        `npm did not confirm the ${npmReleaseTag(inventory.version)} tag for ${pkg.name}`,
      );
    if (
      npmReleaseTag(inventory.version) === "alpha" &&
      registered["dist-tags"]?.latest === inventory.version
    )
      throw new Error(`${pkg.name}: an alpha release must not advance latest`);
  }
  console.log(
    `Verified ${inventory.packages.length} public npm packages at ${inventory.version} (${npmReleaseTag(inventory.version)})`,
  );
}

/** One-time account setup; never called by a routine release workflow. */
function trustReleaseWorkflow(rootPath: string) {
  const release = verifyReleasePackages({ rootPath });
  const runtime = toolRuntime({ rootPath, env: process.env });
  for (const pkg of release.packages) {
    execFileSync(
      runtime.nodePath,
      [
        path.join(rootPath, "node_modules/npm/bin/npm-cli.js"),
        "trust",
        "github",
        pkg.manifest.name,
        "--repo",
        "opencx-labs/catamorphic",
        "--file",
        "desktop-prerelease.yml",
        "--allow-publish",
        "--yes",
        "--registry",
        NPM_REGISTRY,
      ],
      { cwd: pkg.directory, env: runtime.env, stdio: "inherit" },
    );
  }
}

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

if (import.meta.main) {
  const rootPath = path.resolve(import.meta.dirname, "..");
  const command = process.argv[2];
  if (command === "version") {
    setReleaseVersion({ rootPath, version: requiredOption("--version") });
    execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: rootPath,
      stdio: "inherit",
    });
  } else if (command === "verify") {
    const release = verifyReleasePackages({
      rootPath,
      ...(process.argv.includes("--version")
        ? { version: requiredOption("--version") }
        : {}),
    });
    console.log(
      `${release.packages.length} libraries and all apps share ${release.version}`,
    );
  } else if (command === "pack") {
    packReleasePackages({
      rootPath,
      outputPath: path.resolve(requiredOption("--output")),
    });
  } else if (command === "smoke") {
    smokeReleasePackages({
      rootPath,
      directory: path.resolve(requiredOption("--directory")),
    });
  } else if (command === "publish") {
    await publishReleasePackages({
      rootPath,
      directory: path.resolve(requiredOption("--directory")),
    });
  } else if (command === "preflight") {
    const { inventory, pending } = await preflightReleasePackages({
      rootPath,
      directory: path.resolve(requiredOption("--directory")),
    });
    console.log(
      `Verified npm channels for ${inventory.packages.length} libraries; ${pending.length} versions pending`,
    );
  } else if (command === "repair-bootstrap") {
    await repairBootstrapRelease({
      rootPath,
      directory: path.resolve(requiredOption("--directory")),
      runId: requiredOption("--run"),
    });
  } else if (command === "trust") {
    trustReleaseWorkflow(rootPath);
  } else {
    throw new Error(
      "Usage: release-packages.ts <version --version X|verify [--version X]|pack --output DIR|smoke --directory DIR|preflight --directory DIR|publish --directory DIR|repair-bootstrap --run ID --directory DIR|trust>",
    );
  }
}
