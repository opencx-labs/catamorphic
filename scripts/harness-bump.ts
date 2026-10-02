import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Moves a coding harness's desktop pins to a published SDK release (ADR
 * 0196): the SDK the app bundles, the CLI release it ships with, and every
 * platform executable's integrity, together. The scheduled workflow runs
 * this per harness and opens a pull request; CI and review decide.
 *
 *   bun scripts/harness-bump.ts <claude-code|codex> [version] [--output <file>]
 */

const REGISTRY = "https://registry.npmjs.org";
const ROOT = path.resolve(import.meta.dirname, "..");
const COMPONENTS = path.join(
  ROOT,
  "apps/desktop/src/main/harness-components.ts",
);

export type HarnessName = "claude-code" | "codex";

/** What one harness pins, and where. */
export interface HarnessPins {
  name: HarnessName;
  displayName: string;
  /** The TypeScript SDK the app bundles. */
  sdk: string;
  /** The workspace package that depends on it. */
  packageJson: string;
  /** harness-components.ts constants: the SDK and the CLI version. */
  sdkConstant?: string;
  cliConstant: string;
  /** The per-platform integrity key in PLATFORM_RELEASES. */
  integrityKey: string;
  /** The CLI release an SDK manifest ships with. */
  cliVersionOf: (manifest: RegistryVersion) => string | undefined;
  /** The registry package and version holding one platform's executable. */
  executable: (
    target: string,
    sdkVersion: string,
    cliVersion: string,
  ) => {
    name: string;
    version: string;
  };
}

export const HARNESSES: Record<HarnessName, HarnessPins> = {
  "claude-code": {
    name: "claude-code",
    displayName: "Claude Code",
    sdk: "@anthropic-ai/claude-agent-sdk",
    packageJson: "packages/claude-code/package.json",
    sdkConstant: "CLAUDE_VERSION",
    cliConstant: "CLAUDE_CODE_MIN_VERSION",
    integrityKey: "claudeIntegrity",
    cliVersionOf: (manifest) =>
      typeof manifest.claudeCodeVersion === "string"
        ? manifest.claudeCodeVersion
        : undefined,
    executable: (target, sdkVersion) => ({
      name: `@anthropic-ai/claude-agent-sdk-${target}`,
      version: sdkVersion,
    }),
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    sdk: "@openai/codex-sdk",
    packageJson: "packages/codex/package.json",
    cliConstant: "CODEX_VERSION",
    integrityKey: "codexIntegrity",
    cliVersionOf: (manifest) => manifest.dependencies?.["@openai/codex"],
    // Codex publishes each platform build as a tagged version of the CLI.
    executable: (target, _sdkVersion, cliVersion) => ({
      name: "@openai/codex",
      version: `${cliVersion}-${target}`,
    }),
  },
};

export interface HarnessRelease {
  /** The SDK package version, e.g. "0.3.287". */
  sdkVersion: string;
  /** The CLI version that SDK release ships, e.g. "2.1.287". */
  cliVersion: string;
  /** Platform target ("darwin-arm64") → executable package integrity. */
  integrity: Record<string, `sha512-${string}`>;
}

const EXACT = /^\d+\.\d+\.\d+$/;

/** The SDK version the repository pins today. */
export function pinnedSdkVersion(
  harness: HarnessPins,
  packageJson: string,
): string {
  const manifest: { dependencies?: Record<string, string> } =
    JSON.parse(packageJson);
  const version = manifest.dependencies?.[harness.sdk];
  if (!version || !EXACT.test(version))
    throw new Error(`${harness.sdk} must be pinned to an exact version`);
  return version;
}

/** Platform targets the desktop downloads executables for. */
export function componentTargets(source: string): string[] {
  return [...source.matchAll(/^ {2}"([a-z0-9]+-[a-z0-9]+)": \{$/gm)].map(
    (match) => match[1] ?? "",
  );
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Rewrite the package manifest and harness-components.ts for one release. */
export function applyRelease(
  harness: HarnessPins,
  files: { packageJson: string; components: string },
  release: HarnessRelease,
): { packageJson: string; components: string } {
  const packageJson = files.packageJson.replace(
    new RegExp(`("${escapeRegExp(harness.sdk)}": )"[^"]+"`),
    `$1"${release.sdkVersion}"`,
  );
  const constant = (source: string, name: string, value: string) => {
    const pattern = new RegExp(`((?:export )?const ${name} = )"[^"]+";`);
    if (!pattern.test(source)) throw new Error(`No ${name} constant`);
    return source.replace(pattern, `$1"${value}";`);
  };
  let components = constant(
    files.components,
    harness.cliConstant,
    release.cliVersion,
  );
  if (harness.sdkConstant)
    components = constant(components, harness.sdkConstant, release.sdkVersion);
  for (const target of componentTargets(components)) {
    const integrity = release.integrity[target];
    if (!integrity)
      throw new Error(`No ${harness.sdk} executable for ${target}`);
    const block = new RegExp(
      `( {2}"${target}": \\{[^}]*?${harness.integrityKey}:\\s*)"sha512-[^"]+"`,
    );
    if (!block.test(components))
      throw new Error(`No ${harness.integrityKey} pin for ${target}`);
    components = components.replace(block, `$1"${integrity}"`);
  }
  return { packageJson, components };
}

const isSha512 = (value: string): value is `sha512-${string}` =>
  value.startsWith("sha512-");

export interface RegistryVersion {
  version: string;
  claudeCodeVersion?: unknown;
  dependencies?: Record<string, string>;
  dist?: { integrity?: unknown };
}

function isRegistryVersion(value: unknown): value is RegistryVersion {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  );
}

async function registry(name: string, version: string) {
  const response = await fetch(`${REGISTRY}/${name}/${version}`);
  if (!response.ok)
    throw new Error(`${name}@${version}: registry returned ${response.status}`);
  const manifest: unknown = await response.json();
  if (!isRegistryVersion(manifest))
    throw new Error(`${name}@${version}: unexpected registry response`);
  return manifest;
}

/** The release metadata for one SDK version, straight from npm. */
export async function fetchRelease(
  harness: HarnessPins,
  version: string,
  targets: readonly string[],
): Promise<HarnessRelease> {
  const sdk = await registry(harness.sdk, version);
  const cliVersion = harness.cliVersionOf(sdk);
  if (typeof cliVersion !== "string" || !EXACT.test(cliVersion))
    throw new Error(`${harness.sdk}@${sdk.version} names no exact CLI version`);
  const integrity: Record<string, `sha512-${string}`> = {};
  for (const target of targets) {
    const coordinates = harness.executable(target, sdk.version, cliVersion);
    const executable = await registry(coordinates.name, coordinates.version);
    const value = executable.dist?.integrity;
    if (typeof value !== "string" || !isSha512(value))
      throw new Error(
        `${coordinates.name}@${coordinates.version} has no sha512 integrity`,
      );
    integrity[target] = value;
  }
  return { sdkVersion: sdk.version, cliVersion, integrity };
}

const isHarnessName = (value: string | undefined): value is HarnessName =>
  value === "claude-code" || value === "codex";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputFlag = args.indexOf("--output");
  const output = outputFlag === -1 ? undefined : args[outputFlag + 1];
  const positional = args.filter(
    (arg, index) =>
      !arg.startsWith("--") && (outputFlag === -1 || index !== outputFlag + 1),
  );
  const [name, requested = "latest"] = positional;
  if (!isHarnessName(name))
    throw new Error("Usage: harness-bump.ts <claude-code|codex> [version]");
  const harness = HARNESSES[name];
  const packageJsonPath = path.join(ROOT, harness.packageJson);
  const files = {
    packageJson: readFileSync(packageJsonPath, "utf8"),
    components: readFileSync(COMPONENTS, "utf8"),
  };
  const current = pinnedSdkVersion(harness, files.packageJson);
  const release = await fetchRelease(
    harness,
    requested,
    componentTargets(files.components),
  );
  if (release.sdkVersion === current) {
    console.log(`${harness.displayName} is already pinned to ${current}`);
    if (output) appendFileSync(output, "changed=false\n");
  } else {
    const next = applyRelease(harness, files, release);
    writeFileSync(packageJsonPath, next.packageJson);
    writeFileSync(COMPONENTS, next.components);
    console.log(
      `${harness.displayName} ${current} → ${release.sdkVersion} (CLI ${release.cliVersion})`,
    );
    if (output)
      appendFileSync(
        output,
        `changed=true\nfrom=${current}\nsdk=${release.sdkVersion}\ncli=${release.cliVersion}\n`,
      );
  }
}
