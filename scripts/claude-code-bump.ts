import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Moves the desktop's Claude Code pins to a published Claude Agent SDK
 * release (ADR 0196): the SDK the app bundles, the CLI version an installed
 * Claude Code must reach, and every platform executable's integrity. The
 * scheduled workflow runs this and opens a pull request; CI decides.
 */

const SDK = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = "https://registry.npmjs.org";
const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_JSON = path.join(ROOT, "packages/claude-code/package.json");
const COMPONENTS = path.join(
  ROOT,
  "apps/desktop/src/main/harness-components.ts",
);

export interface ClaudeCodeRelease {
  /** The SDK package version, e.g. "0.3.287". */
  sdkVersion: string;
  /** The Claude Code CLI version that SDK release ships, e.g. "2.1.287". */
  cliVersion: string;
  /** Platform target ("darwin-arm64") → executable package integrity. */
  integrity: Record<string, `sha512-${string}`>;
}

/** The SDK version the repository pins today. */
export function pinnedSdkVersion(packageJson: string): string {
  const manifest: { dependencies?: Record<string, string> } =
    JSON.parse(packageJson);
  const version = manifest.dependencies?.[SDK];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`${SDK} must be pinned to an exact version`);
  return version;
}

/** Platform targets the desktop downloads executables for. */
export function componentTargets(source: string): string[] {
  return [...source.matchAll(/^ {2}"([a-z0-9]+-[a-z0-9]+)": \{$/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** Rewrite package.json and harness-components.ts for one release. */
export function applyRelease(
  files: { packageJson: string; components: string },
  release: ClaudeCodeRelease,
): { packageJson: string; components: string } {
  const packageJson = files.packageJson.replace(
    new RegExp(`("${SDK.replace("/", "\\/")}": )"[^"]+"`),
    `$1"${release.sdkVersion}"`,
  );
  let components = files.components
    .replace(
      /const CLAUDE_VERSION = "[^"]+";/,
      `const CLAUDE_VERSION = "${release.sdkVersion}";`,
    )
    .replace(
      /export const CLAUDE_CODE_MIN_VERSION = "[^"]+";/,
      `export const CLAUDE_CODE_MIN_VERSION = "${release.cliVersion}";`,
    );
  for (const target of componentTargets(components)) {
    const integrity = release.integrity[target];
    if (!integrity) throw new Error(`No ${SDK} executable for ${target}`);
    const block = new RegExp(
      `( {2}"${target}": \\{[^}]*?claudeIntegrity:\\s*)"sha512-[^"]+"`,
    );
    if (!block.test(components))
      throw new Error(`No claudeIntegrity pin for ${target}`);
    components = components.replace(block, `$1"${integrity}"`);
  }
  return { packageJson, components };
}

const isSha512 = (value: string): value is `sha512-${string}` =>
  value.startsWith("sha512-");

interface RegistryVersion {
  version: string;
  claudeCodeVersion?: string;
  dist?: { integrity?: string };
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
  version: string,
  targets: readonly string[],
): Promise<ClaudeCodeRelease> {
  const sdk = await registry(SDK, version);
  if (
    typeof sdk.claudeCodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(sdk.claudeCodeVersion)
  )
    throw new Error(`${SDK}@${sdk.version} names no claudeCodeVersion`);
  const integrity: Record<string, `sha512-${string}`> = {};
  for (const target of targets) {
    const executable = await registry(`${SDK}-${target}`, sdk.version);
    const value = executable.dist?.integrity;
    if (typeof value !== "string" || !isSha512(value))
      throw new Error(
        `${SDK}-${target}@${sdk.version} has no sha512 integrity`,
      );
    integrity[target] = value;
  }
  return {
    sdkVersion: sdk.version,
    cliVersion: sdk.claudeCodeVersion,
    integrity,
  };
}

if (import.meta.main) {
  // claude-code-bump.ts [version] [--output <file>]: --output receives
  // key=value lines (the workflow passes $GITHUB_OUTPUT).
  const args = process.argv.slice(2);
  const outputFlag = args.indexOf("--output");
  const output = outputFlag === -1 ? undefined : args[outputFlag + 1];
  const requested =
    args.find(
      (arg, index) => !arg.startsWith("--") && index !== outputFlag + 1,
    ) ?? "latest";
  const files = {
    packageJson: readFileSync(PACKAGE_JSON, "utf8"),
    components: readFileSync(COMPONENTS, "utf8"),
  };
  const current = pinnedSdkVersion(files.packageJson);
  const release = await fetchRelease(
    requested,
    componentTargets(files.components),
  );
  if (release.sdkVersion === current) {
    console.log(`Claude Code is already pinned to ${current}`);
    if (output) appendFileSync(output, "changed=false\n");
  } else {
    const next = applyRelease(files, release);
    writeFileSync(PACKAGE_JSON, next.packageJson);
    writeFileSync(COMPONENTS, next.components);
    console.log(
      `Claude Code ${current} → ${release.sdkVersion} (CLI ${release.cliVersion})`,
    );
    if (output)
      appendFileSync(
        output,
        `changed=true\nfrom=${current}\nsdk=${release.sdkVersion}\ncli=${release.cliVersion}\n`,
      );
  }
}
